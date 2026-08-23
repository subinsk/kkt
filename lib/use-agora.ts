"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  IAgoraRTCClient,
  IAgoraRTCRemoteUser,
  ILocalAudioTrack,
  IRemoteAudioTrack,
} from "agora-rtc-sdk-ng";

/**
 * The audio layer — spec §2.
 *
 * The governing rule, and the reason this file is shaped the way it is:
 *
 *   **Every client subscribes to every track. Each client decides
 *   independently which tracks to PLAY.**
 *
 * All five participants are in the same physical room. If Player 1 speaks and
 * Player 2's phone plays that audio, Player 2 hears the same sentence twice —
 * once through air at ~0ms and again over the network 150–250ms later. That is
 * not stereo, it is slapback echo, and three phones with open mics and open
 * speakers in one room is a feedback loop on top of it.
 *
 * So playback is a per-client policy, not an architectural change: one config
 * object, three deployment modes, the same code.
 */

export type AudioMode = "A" | "B" | "C";

const POLICY: Record<AudioMode, { play: ("agent" | "players")[] }> = {
  /** Co-located, room speaker. What we ship. Phones play nothing. */
  A: { play: ["agent"] },
  /** Co-located, earbuds. Agent into the ear; other players still via air. */
  B: { play: ["agent"] },
  /** Remote. Full conference — correct the moment someone is not in the room. */
  C: { play: ["agent", "players"] },
};

export type AgoraRole =
  /** A contestant's phone: publishes a mic, plays nothing in Mode A. */
  | "player"
  /** The projector: publishes nothing, plays the host through room speakers. */
  | "stage"
  /**
   * The host console: subscribes, publishes nothing, and plays NOTHING.
   *
   * It still needs the host's audio *level*, because that is what drives the
   * head-bob in its 3D preview — and `getVolumeLevel()` reads the received
   * stream whether or not anything is playing it. Playing here would put a
   * second speaker in the room, since the console usually runs on the same
   * laptop as the projector.
   */
  | "monitor";

export type AgoraCredentials = {
  appId: string;
  channel: string;
  uid: number;
  token: string;
  agentUid: number;
};

export type UseAgoraOptions = {
  role: AgoraRole;
  credentials: AgoraCredentials | null;
  mode?: AudioMode;
  /** Contestant id, for level telemetry. Players only. */
  playerId?: string;
  roomCode?: string;
  /**
   * Peer Talk. True means this contestant is talking to the other contestants
   * and the host must not hear them, so we unpublish rather than ask anyone to
   * ignore it — there is then nothing to ignore.
   */
  peerMode?: boolean;
  /**
   * Hard silence, overriding Peer Talk.
   *
   * Two situations need it and both are spec requirements:
   *   - this handset's own lifeline call is live, and its earpiece is inches
   *     from an open mic (§9.5) — otherwise the host hears his own pre-recorded
   *     hint come back and reacts to it
   *   - the round has ended and the outcome stinger is playing (§10.2) —
   *     otherwise he tries to parse a cheering room
   */
  forceSilent?: boolean;
};

/**
 * One in-flight lifecycle per channel+uid, serialised.
 *
 * React StrictMode mounts every effect twice in development: mount, cleanup,
 * mount. `client.leave()` is async, so the second join starts while the first
 * connection is still tearing down — and Agora rejects the duplicate with
 * `UID_CONFLICT`, which surfaces as "mic problem" on the handset with no hint
 * that it was self-inflicted.
 *
 * Chaining every join and leave for a given uid onto the same promise makes the
 * second mount wait for the first to finish leaving. Keyed by channel+uid rather
 * than globally, so three contestants still connect in parallel.
 */
const lifecycles = new Map<string, Promise<unknown>>();

function serialise<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = lifecycles.get(key) ?? Promise.resolve();
  // Swallow the predecessor's failure — a failed leave must not block the join.
  const next = previous.catch(() => {}).then(work);
  lifecycles.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

export function useAgora(options: UseAgoraOptions) {
  const {
    role,
    credentials,
    mode = "A",
    playerId,
    roomCode,
    peerMode = true,
    forceSilent = false,
  } = options;

  const [joined, setJoined] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 0..1, driven by the host's track. The 3D scene reads this every frame. */
  const [agentLevel, setAgentLevel] = useState(0);
  const [agentPresent, setAgentPresent] = useState(false);

  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const localTrackRef = useRef<ILocalAudioTrack | null>(null);
  const agentTrackRef = useRef<IRemoteAudioTrack | null>(null);
  const agentLevelRef = useRef(0);
  const publishedRef = useRef(false);

  /* ------------------------------------------------------------ join ----- */

  useEffect(() => {
    if (!credentials) return;

    let cancelled = false;
    let client: IAgoraRTCClient | null = null;

    const key = `${credentials.channel}:${credentials.uid}`;

    void serialise(key, async () => {
      try {
        // Browser-only SDK — importing it at module scope breaks the server
        // render of any page that uses this hook.
        const AgoraRTC = (await import("agora-rtc-sdk-ng")).default;
        AgoraRTC.setLogLevel(3);

        // `codec` is the VIDEO codec and is required even on an audio-only
        // client, where it is ignored. Audio is Opus regardless; there is no
        // "opus" value to pass here and the type rejects it.
        client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
        clientRef.current = client;

        client.on("user-published", async (user, mediaType) => {
          if (mediaType !== "audio") return;
          // Subscribe unconditionally. Deciding *here* whether to subscribe
          // would make playback policy an architectural choice, which is
          // exactly what we are avoiding.
          await client!.subscribe(user, mediaType);

          const isAgent = Number(user.uid) === credentials.agentUid;
          // A monitor never plays anything, whatever the mode says.
          const allowed =
            role === "monitor"
              ? false
              : isAgent
                ? POLICY[mode].play.includes("agent")
                : POLICY[mode].play.includes("players");

          if (isAgent) {
            agentTrackRef.current = user.audioTrack ?? null;
            setAgentPresent(true);
          }

          if (allowed && user.audioTrack) user.audioTrack.play();
        });

        client.on("user-unpublished", (user, mediaType) => {
          if (mediaType !== "audio") return;
          if (Number(user.uid) === credentials.agentUid) {
            agentTrackRef.current = null;
            setAgentPresent(false);
            setAgentLevel(0);
          }
        });

        client.on("user-left", (user: IAgoraRTCRemoteUser) => {
          if (Number(user.uid) === credentials.agentUid) {
            setAgentPresent(false);
          }
        });

        await client.join(
          credentials.appId,
          credentials.channel,
          credentials.token,
          credentials.uid,
        );
        if (cancelled) return;
        setJoined(true);

        if (role === "player") {
          const track = await AgoraRTC.createMicrophoneAudioTrack({
            AEC: true,
            ANS: true,
            AGC: true,
          });
          if (cancelled) {
            track.close();
            return;
          }
          localTrackRef.current = track;
          // Published once and then enabled/disabled. Republishing on every
          // Peer Talk toggle would renegotiate and add a visible lag to a
          // button people press constantly.
          // Muted before it is published, so a handset that joins mid-round
          // never leaks a second of audio before the effect above catches up.
          await track.setMuted(desiredMuteRef.current);
          await client.publish(track);
          publishedRef.current = true;
          setMicReady(true);
        }
      } catch (err) {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : "Could not join audio";
          setError(
            // Worth naming, because it reads like a device fault and is not.
            message.includes("UID_CONFLICT")
              ? "Yeh seat already connected hai. Page refresh karo."
              : message,
          );
        }
      }
    });

    return () => {
      cancelled = true;

      // Tear down on the same chain, so the next mount waits for this to finish
      // rather than racing it.
      void serialise(key, async () => {
        const track = localTrackRef.current;
        localTrackRef.current = null;
        agentTrackRef.current = null;
        publishedRef.current = false;

        if (track) {
          track.stop();
          track.close();
        }
        client?.removeAllListeners();
        try {
          await client?.leave();
        } catch {
          // Already gone. Nothing to do.
        }
        clientRef.current = null;
      });

      setJoined(false);
      setMicReady(false);
    };
    // Re-joining on a mode change would drop everyone mid-round; mode is read
    // fresh inside the handler instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentials, role]);

  /* -------------------------------------------------- peer talk gate ----- */

  /**
   * The one place that decides whether this handset is transmitting.
   *
   * `setMuted`, not `setEnabled`. On a track that is already published,
   * `setEnabled(false)` tears the track down and republishes it on the way back
   * — which is slow, can fail, and made the toggle feel dead or stick on. Mute
   * keeps the track published and simply sends silence, so it flips instantly
   * and cannot desync from the button.
   *
   * Everything that can silence the mic resolves in one expression. Two effects
   * writing this from different conditions is how you get a handset that is live
   * while the UI says muted — which in this game means a private conversation
   * going out over the room speakers.
   */
  const desiredMute = peerMode || forceSilent;
  const desiredMuteRef = useRef(desiredMute);
  desiredMuteRef.current = desiredMute;

  useEffect(() => {
    const track = localTrackRef.current;
    if (!track || !micReady) return;
    void track.setMuted(desiredMute);
  }, [desiredMute, micReady]);

  /* ---------------------------------------------- level + telemetry ------ */

  useEffect(() => {
    if (!joined) return;

    /**
     * Read the host's level for the 3D scene.
     *
     * Deliberately `getVolumeLevel()` rather than an AnalyserNode: Agora is
     * already playing this track, and wiring an analyser through to
     * `audioContext.destination` would play it a second time.
     */
    const levelTimer = setInterval(() => {
      const track = agentTrackRef.current;
      const raw = track ? track.getVolumeLevel() : 0;
      // Smoothed, because a raw per-frame level makes anything driven by it
      // jitter rather than breathe.
      agentLevelRef.current = agentLevelRef.current * 0.7 + raw * 0.3;
      setAgentLevel(agentLevelRef.current);
    }, 60);

    return () => clearInterval(levelTimer);
  }, [joined]);

  /**
   * Mic-level telemetry — spec §2.5, the attribution fallback.
   *
   * Sampled at ~30Hz and flushed every 200ms in one POST. Peer Talk means one
   * mic is usually live and attribution is already unambiguous, so this exists
   * for the case where two contestants deliberately go live together.
   */
  useEffect(() => {
    if (role !== "player" || !micReady || !playerId || !roomCode) return;

    let samples: { t: number; level: number }[] = [];

    const sampler = setInterval(() => {
      const track = localTrackRef.current;
      if (!track) return;
      samples.push({ t: Date.now(), level: track.getVolumeLevel() });
    }, 33);

    const flusher = setInterval(() => {
      if (samples.length === 0) return;
      const batch = samples;
      samples = [];
      void fetch(`/api/room/${encodeURIComponent(roomCode)}/levels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId, samples: batch }),
        keepalive: true,
      }).catch(() => {
        // Telemetry is best-effort. Losing a batch costs nothing.
      });
    }, 200);

    return () => {
      clearInterval(sampler);
      clearInterval(flusher);
    };
  }, [role, micReady, playerId, roomCode]);

  /* ---------------------------------------------------------- ducking ---- */

  /**
   * Capture ducking — spec §2.4.
   *
   * In Mode A the room speaker leaks into every open phone mic, and each
   * phone's AEC cannot help because it is not the device producing the sound.
   * So when we know the host is speaking, we drop capture gain to a floor.
   *
   * Barge-in survives: a raised voice into a handset punches straight through
   * 25%, which is the entire point of picking a floor rather than a mute.
   */
  const duck = useCallback((speaking: boolean) => {
    localTrackRef.current?.setVolume(speaking ? 25 : 100);
  }, []);

  /** Escape hatch. Prefer `forceSilent`, which the effect above owns. */
  const setMicEnabled = useCallback((enabled: boolean) => {
    void localTrackRef.current?.setMuted(!enabled);
  }, []);

  return {
    joined,
    micReady,
    /** What the mic is actually doing, so the UI cannot claim otherwise. */
    muted: desiredMute,
    error,
    agentLevel,
    agentPresent,
    agentLevelRef,
    duck,
    setMicEnabled,
  };
}

/** Read the shipped mode from the environment, defaulting to the safe one. */
export function configuredMode(): AudioMode {
  const raw = (process.env.NEXT_PUBLIC_AUDIO_MODE ?? "A").toUpperCase();
  return raw === "B" || raw === "C" ? raw : "A";
}
