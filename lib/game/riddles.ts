/**
 * The riddle bank — five fixed riddles, one per wire.
 *
 * Deliberately static and deliberately famous. These are the paheliyan every
 * Indian child already knows, which matters more than variety: a judge who
 * *recognises* the riddle engages with the show instead of stalling on it, and
 * the thing being demoed is the conversation, not the puzzle difficulty.
 *
 * Fixed wire→riddle mapping means "blue wale ka batao" is reproducible across
 * rehearsals, so the run-through you practise is the run-through you demo.
 *
 * Two text fields per riddle:
 *
 *   `speak` is Devanagari, because Sarvam Bulbul is a Hindi voice and
 *   Roman-script Hindi ("Bahar se sakht") is not reliably pronounced by an
 *   Indic TTS model — it tends to read it as English. UNVERIFIED whether
 *   Bulbul transliterates Roman input; giving it Devanagari removes the
 *   question entirely.
 *
 *   `screen` is Roman, because that is what reads instantly on a phone held at
 *   arm's length and on a projected chyron.
 *
 * `accept` is a *hint to the judge*, not a matcher. Answer checking is semantic
 * and runs through the LLM — spec §6. A regex here would embarrass us live.
 *
 * `nearMiss` is what makes hints feel intelligent rather than canned: the host
 * answers the specific wrong thing that was actually said.
 *
 * `hints[0]` is the line that Phone a Friend loops down the phone, so it has to
 * stand alone without the riddle for context — spec §9.3.
 */

import type { WireColor } from "./state";

export type Riddle = {
  id: string;
  /** The wire this riddle is permanently bound to. */
  wire: WireColor;
  speak: string;
  screen: string;
  accept: string[];
  nearMiss: Record<string, string>;
  hints: string[];
};

export const RIDDLES: Riddle[] = [
  {
    id: "r_nariyal",
    wire: "red",
    speak: "बाहर से सख़्त, अंदर से पानी। कौन हूँ मैं?",
    screen: "Bahar se sakht, andar se paani. Kaun hoon main?",
    accept: ["coconut", "nariyal", "naariyal", "narial", "नारियल"],
    nearMiss: {
      watermelon: "Paani to hai, par bahar se sakht nahi. Aur socho.",
      egg: "Bahar sakht hai — par andar paani nahi, kuch aur hai.",
      "water bottle": "Cheez natural hai, banayi hui nahi.",
      matka: "Paani rakhta hai, par ye ped par ugta hai.",
    },
    hints: [
      "Ye ek fruit hai, jo mandir mein chadhaya jaata hai.",
      "Ise tod kar iska paani peete hain.",
      "Ped par ugta hai, aur iska naam N se shuru hota hai.",
    ],
  },
  {
    id: "r_parchhai",
    wire: "blue",
    speak: "मैं हमेशा आपके साथ चलती हूँ, पर आप मुझे पकड़ नहीं सकते। अंधेरे में गायब हो जाती हूँ।",
    screen: "Hamesha saath chalti hoon, par pakad nahi sakte. Andhere mein gayab.",
    accept: ["shadow", "parchhai", "parchhaai", "chhaya", "परछाई"],
    nearMiss: {
      air: "Hawa andhere mein gayab nahi hoti. Ye roshni se banti hai.",
      reflection: "Kareeb ho — par iske liye sheesha nahi chahiye.",
      ghost: "Bhoot ka koi bharosa nahi! Ye har dhoop mein dikhti hai.",
      soul: "Aatma se halka soch. Ye dhoop mein zameen par dikhti hai.",
    },
    hints: [
      "Ye roshni se banti hai, aur dhoop mein zameen par dikhti hai.",
      "Dopahar mein chhoti hoti hai, aur shaam ko lambi.",
      "Ye aapki hi shakal hai, par kaali.",
    ],
  },
  {
    id: "r_sui",
    wire: "yellow",
    speak: "मेरी एक आँख है, पर मैं देख नहीं सकती। मैं कपड़े जोड़ती हूँ।",
    screen: "Ek aankh hai par dekh nahi sakti. Kapde jodti hoon.",
    accept: ["needle", "sui", "suii", "सुई"],
    nearMiss: {
      button: "Button jodta nahi, jud jaata hai. Jo jodta hai wo kya hai?",
      thread: "Dhaaga iske bina kapde tak nahi pahunchta.",
      "sewing machine": "Bahut bada soch liya. Ek chhoti si cheez hai.",
      scissors: "Kainchi kaatti hai, jodti nahi. Ulta soch rahe ho.",
    },
    hints: [
      "Ye bahut chhoti aur nukeeli hai, aur darzi ke haath mein hoti hai.",
      "Iske chhed mein dhaaga daalte hain.",
      "Isse kapde silte hain.",
    ],
  },
  {
    id: "r_pyaaz",
    wire: "green",
    speak: "मेरी कई परतें हैं, और मैं बिना दुख के भी रुला देती हूँ।",
    screen: "Kai parte hain, aur bina dukh ke rula deti hoon.",
    accept: ["onion", "pyaaz", "pyaz", "kanda", "प्याज़"],
    nearMiss: {
      garlic: "Lehsun ki parte hain, par wo rulata nahi.",
      cabbage: "Parte to hain — par aankh se paani nahi aata.",
      chilli: "Mirchi rulati hai, par uski parte nahi hain.",
      book: "Kitaab ke panne hain, par wo rulati nahi!",
    },
    hints: [
      "Ye ek sabzi hai jo kaatne par aankh mein paani laa deti hai.",
      "Har sabzi mein sabse pehle ye padti hai.",
      "Iske daam par siyasat hoti hai.",
    ],
  },
  {
    id: "r_mombatti",
    wire: "white",
    speak: "जितना जीती हूँ उतनी छोटी होती जाती हूँ। रोशनी देती हूँ और रोती भी हूँ।",
    screen:
      "Jitna jeeti hoon utni chhoti hoti jaati hoon. Roshni deti hoon, roti bhi hoon.",
    accept: ["candle", "mombatti", "mombatee", "मोमबत्ती"],
    nearMiss: {
      pencil: "Chhoti to hoti hai — par roshni nahi deti.",
      bulb: "Bulb chhota nahi hota. Aur ye pighalti hai.",
      ice: "Barf chhoti hoti hai, par andhere mein kaam nahi aati.",
      matchstick: "Kareeb! Par ye der tak jalti hai, aur pighalti hai.",
    },
    hints: [
      "Ye mom se banti hai aur jalne par pighalti hai.",
      "Birthday par ise bujhate hain.",
      "Bijli chali jaaye to ye kaam aati hai.",
    ],
  },
];

/** Every riddle keyed by id, for O(1) lookup from tool handlers. */
export const RIDDLES_BY_ID: Record<string, Riddle> = Object.fromEntries(
  RIDDLES.map((r) => [r.id, r]),
);

/** Riddle per wire — the mapping is fixed, so this is the primary lookup. */
export const RIDDLE_BY_WIRE: Record<WireColor, Riddle> = Object.fromEntries(
  RIDDLES.map((r) => [r.wire, r]),
) as Record<WireColor, Riddle>;

export function getRiddle(id: string): Riddle | undefined {
  return RIDDLES_BY_ID[id];
}

export function riddleForWire(wire: WireColor): Riddle {
  return RIDDLE_BY_WIRE[wire];
}

/**
 * The audio file Phone a Friend loops for a wire — spec §9.3.
 *
 * Pre-rendered with Sarvam Bulbul before the event rather than synthesised at
 * call time: telephony-grade Hindi TTS is rough, a clip that already exists has
 * zero dial-time latency, and hearing the *same voice* on the phone that is in
 * the room is a lovely continuity touch.
 *
 * WAV rather than MP3, which the spec assumed. Sarvam returns WAV and Vobiz
 * accepts WAV, so converting would mean adding an ffmpeg dependency to gain
 * nothing. Rendered at 8 kHz mono, which is telephony bandwidth anyway.
 *
 * Vobiz silently skips audio it cannot fetch, so a missing file is dead air on
 * a live call rather than an error. `npm run render:hints` creates these and
 * /api/health tells you if any are absent.
 */
export function hintAudioPath(wire: WireColor): string {
  return `/audio/hints/${RIDDLE_BY_WIRE[wire].id}_h1.wav`;
}
