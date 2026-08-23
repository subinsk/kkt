/**
 * Phone a Friend — spec §9.
 *
 * The external action, the human escalation path, and the Vobiz integration in
 * one mechanic. A phone actually ringing in the room is the thing judges will
 * still be talking about at the end of the day.
 *
 * Why this does not go through Agora telephony: Agora's SIP surface is a 1:1
 * phone-to-agent model. Outbound means creating a *campaign* and uploading a
 * CSV, which is a batch workflow — we need a dial within about two seconds of a
 * button press. And there is no documented way to inject a PSTN caller into an
 * existing multi-party RTC channel. So Agora ConvoAI owns the game and Vobiz
 * owns the lifeline, called directly from here.
 */

import { makeCall } from "../vobiz";
import { hintAudioPath } from "./riddles";
import { PENALTY_LIFELINE, findPlayer, type Game } from "./state";
import { beginLifeline, emit, lifelineFailed } from "./store";
import { optional, publicBaseUrl } from "../env";

/** Correlates the Vobiz webhooks back to the room that placed the call. */
export type LifelineCall = {
  id: string;
  room: string;
  playerId: string;
  requestUuid: string | null;
  callUuid: string | null;
  wire: string;
  createdAt: number;
};

const globalStore = globalThis as unknown as {
  __kktCalls?: Map<string, LifelineCall>;
};
const calls: Map<string, LifelineCall> = (globalStore.__kktCalls ??= new Map());

export function findCall(id: string): LifelineCall | undefined {
  return calls.get(id);
}

/** Vobiz webhooks identify a call by uuid, not by our id. */
export function findCallByUuid(uuid: string): LifelineCall | undefined {
  for (const call of calls.values()) {
    if (call.callUuid === uuid || call.requestUuid === uuid) return call;
  }
  return undefined;
}

export function attachCallUuid(id: string, callUuid: string) {
  const call = calls.get(id);
  if (call) call.callUuid = callUuid;
}

/**
 * Dial the friend.
 *
 * Note what is *not* here: the 45-second penalty. It is charged on the
 * `answered` webhook, never on dial. Indian mobiles ring for three to eight
 * seconds and charging the team for ring time feels broken — judges notice.
 */
export async function startLifeline(game: Game, playerId: string) {
  const player = findPlayer(game, playerId);
  if (!player) throw new Error(`No such contestant: ${playerId}`);

  /**
   * Permission is checked here, not in the UI.
   *
   * The button being disabled is a courtesy; this is the actual gate. A phone
   * with a stale page, or anything replaying an old request, must not be able to
   * spend forty-five seconds of somebody's round.
   */
  if (!game.lifeline.granted) {
    throw new Error(
      "The host has not approved the lifeline yet. Ask them out loud first, and only call this once they have said yes.",
    );
  }

  if (!game.activeWire) {
    throw new Error(
      "No wire is active, so there is no hint to read out. Select a wire first.",
    );
  }

  // A fallback number keeps the demo alive when a judge declines to give
  // theirs — which is a reasonable thing for a stranger to decline.
  const to =
    player.consent && player.phoneE164
      ? player.phoneE164
      : optional("FALLBACK_FRIEND_NUMBER", "");

  if (!to) {
    throw new Error(
      `${player.name} did not give a number, and no fallback number is configured. Tell them the lifeline cannot be placed and that no time has been charged.`,
    );
  }

  const id = `LL-${game.code}-${Date.now().toString(36)}`;
  const wire = game.activeWire;

  // Marked used before dialling so a double-tap cannot place two calls.
  beginLifeline(game, playerId, id);
  calls.set(id, {
    id,
    room: game.code,
    playerId,
    requestUuid: null,
    callUuid: null,
    wire,
    createdAt: Date.now(),
  });

  const base = publicBaseUrl();

  try {
    const result = await makeCall({
      to,
      answerUrl: `${base}/api/vobiz/answer?call=${encodeURIComponent(id)}`,
      hangupUrl: `${base}/api/vobiz/hangup?call=${encodeURIComponent(id)}`,
      ringUrl: `${base}/api/vobiz/ring?call=${encodeURIComponent(id)}`,
      callerName: "KKT Lifeline",
      // A hard ceiling in case a webhook is lost — the call can never outlive
      // the round and sit there costing money.
      timeLimitSeconds: 75,
    });

    const call = calls.get(id);
    if (call) call.requestUuid = result.request_uuid;

    emit(game, "lifeline_queued", {
      playerId,
      callId: id,
      wire,
      requestUuid: result.request_uuid,
    });

    return {
      call_id: id,
      status: "dialing",
      wire,
      // Told to the model explicitly, because "when does the clock start" is
      // exactly the kind of thing it would otherwise state wrongly.
      cost_seconds: PENALTY_LIFELINE,
      instruction:
        "The phone is ringing. Say so in character. The time cost starts only when someone actually picks up — ringing is free, and saying that out loud sounds fair because it is.",
    };
  } catch (error) {
    // Requirement #9: behave sanely and *visibly* when an external API fails.
    const reason = error instanceof Error ? error.message : "carrier error";
    calls.delete(id);
    lifelineFailed(game, reason);

    return {
      call_id: null,
      status: "failed",
      wire,
      cost_seconds: 0,
      instruction:
        "The call could not be placed. Say so plainly and in character, tell them no time was charged, and that the lifeline is still theirs to use. Do not hide the failure — then get straight back to the riddle.",
      error: reason,
    };
  }
}

/** The MP3 the call loops — pre-rendered, so there is no dial-time latency. */
export function hintAudioUrl(wire: string): string {
  const base = publicBaseUrl();
  return `${base}${hintAudioPath(wire as never)}`;
}
