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
 * Two text fields per riddle, and the split runs through the whole file:
 * **everything spoken is Devanagari, everything read is Roman.**
 *
 *   `speak`, `hints` and the `nearMiss` *values* are Devanagari, because Sarvam
 *   Bulbul is a Hindi voice and Roman-script Hindi ("Bahar se sakht") is read as
 *   English — a phrasebook accent on every line. `hints` matter twice over: the
 *   host says them out loud, and `hints[0]` is rendered straight to WAV for the
 *   Phone a Friend call, where there is no model in the loop to fix the script.
 *
 *   `screen` is Roman, because that is what reads instantly on a phone held at
 *   arm's length and on a projected chyron. It is never spoken.
 *
 *   `nearMiss` *keys* are matched against what the contestant said, so they are
 *   the one place both scripts belong: Roman for an English guess ("watermelon")
 *   and Devanagari for a Hindi one ("तरबूज़"), pointing at the same line. The
 *   host writes its `wrong_answer` tool argument in Devanagari now, so a
 *   Roman-only key list would quietly stop matching and every hint would fall
 *   back to generic.
 *
 * `accept` is a *hint to the judge*, not a matcher. Answer checking is semantic
 * and runs through the LLM — spec §6. A regex here would embarrass us live.
 *
 * `nearMiss` is what makes hints feel intelligent rather than canned: the host
 * answers the specific wrong thing that was actually said.
 *
 * `hints[0]` is the line that Phone a Friend loops down the phone, so it has to
 * stand alone without the riddle for context — spec §9.3, and it is why these
 * are Devanagari rather than transliterated at render time.
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
      watermelon: "पानी तो है, पर बाहर से सख़्त नहीं। और सोचो।",
      तरबूज़: "पानी तो है, पर बाहर से सख़्त नहीं। और सोचो।",
      egg: "बाहर सख़्त है — पर अंदर पानी नहीं, कुछ और है।",
      अंडा: "बाहर सख़्त है — पर अंदर पानी नहीं, कुछ और है।",
      "water bottle": "चीज़ नैचुरल है, बनाई हुई नहीं।",
      बोतल: "चीज़ नैचुरल है, बनाई हुई नहीं।",
      matka: "पानी रखता है, पर ये पेड़ पर उगता है।",
      मटका: "पानी रखता है, पर ये पेड़ पर उगता है।",
    },
    hints: [
      "ये एक फल है, जो मंदिर में चढ़ाया जाता है।",
      "इसे तोड़ कर इसका पानी पीते हैं।",
      "पेड़ पर उगता है, और इसका नाम न से शुरू होता है।",
    ],
  },
  {
    id: "r_parchhai",
    wire: "blue",
    speak: "मैं हमेशा आपके साथ चलती हूँ, पर आप मुझे पकड़ नहीं सकते। अंधेरे में गायब हो जाती हूँ।",
    screen: "Hamesha saath chalti hoon, par pakad nahi sakte. Andhere mein gayab.",
    accept: ["shadow", "parchhai", "parchhaai", "chhaya", "परछाई"],
    nearMiss: {
      air: "हवा अंधेरे में गायब नहीं होती। ये रोशनी से बनती है।",
      हवा: "हवा अंधेरे में गायब नहीं होती। ये रोशनी से बनती है।",
      reflection: "क़रीब हो — पर इसके लिए शीशा नहीं चाहिए।",
      अक्स: "क़रीब हो — पर इसके लिए शीशा नहीं चाहिए।",
      ghost: "भूत का कोई भरोसा नहीं! ये हर धूप में दिखती है।",
      भूत: "भूत का कोई भरोसा नहीं! ये हर धूप में दिखती है।",
      soul: "आत्मा से हल्का सोचो। ये धूप में ज़मीन पर दिखती है।",
      आत्मा: "आत्मा से हल्का सोचो। ये धूप में ज़मीन पर दिखती है।",
    },
    hints: [
      "ये रोशनी से बनती है, और धूप में ज़मीन पर दिखती है।",
      "दोपहर में छोटी होती है, और शाम को लंबी।",
      "ये आपकी ही शकल है, पर काली।",
    ],
  },
  {
    id: "r_sui",
    wire: "yellow",
    speak: "मेरी एक आँख है, पर मैं देख नहीं सकती। मैं कपड़े जोड़ती हूँ।",
    screen: "Ek aankh hai par dekh nahi sakti. Kapde jodti hoon.",
    accept: ["needle", "sui", "suii", "सुई"],
    nearMiss: {
      button: "बटन जोड़ता नहीं, जुड़ जाता है। जो जोड़ता है वो क्या है?",
      बटन: "बटन जोड़ता नहीं, जुड़ जाता है। जो जोड़ता है वो क्या है?",
      thread: "धागा इसके बिना कपड़े तक नहीं पहुँचता।",
      धागा: "धागा इसके बिना कपड़े तक नहीं पहुँचता।",
      "sewing machine": "बहुत बड़ा सोच लिया। एक छोटी सी चीज़ है।",
      मशीन: "बहुत बड़ा सोच लिया। एक छोटी सी चीज़ है।",
      scissors: "कैंची काटती है, जोड़ती नहीं। उल्टा सोच रहे हो।",
      कैंची: "कैंची काटती है, जोड़ती नहीं। उल्टा सोच रहे हो।",
    },
    hints: [
      "ये बहुत छोटी और नुकीली है, और दर्ज़ी के हाथ में होती है।",
      "इसके छेद में धागा डालते हैं।",
      "इससे कपड़े सिलते हैं।",
    ],
  },
  {
    id: "r_pyaaz",
    wire: "green",
    speak: "मेरी कई परतें हैं, और मैं बिना दुख के भी रुला देती हूँ।",
    screen: "Kai parte hain, aur bina dukh ke rula deti hoon.",
    accept: ["onion", "pyaaz", "pyaz", "kanda", "प्याज़"],
    nearMiss: {
      garlic: "लहसुन की परतें हैं, पर वो रुलाता नहीं।",
      लहसुन: "लहसुन की परतें हैं, पर वो रुलाता नहीं।",
      cabbage: "परतें तो हैं — पर आँख से पानी नहीं आता।",
      गोभी: "परतें तो हैं — पर आँख से पानी नहीं आता।",
      chilli: "मिर्ची रुलाती है, पर उसकी परतें नहीं हैं।",
      मिर्ची: "मिर्ची रुलाती है, पर उसकी परतें नहीं हैं।",
      book: "किताब के पन्ने हैं, पर वो रुलाती नहीं!",
      किताब: "किताब के पन्ने हैं, पर वो रुलाती नहीं!",
    },
    hints: [
      "ये एक सब्ज़ी है जो काटने पर आँख में पानी ला देती है।",
      "हर सब्ज़ी में सबसे पहले ये पड़ती है।",
      "इसके दाम पर सियासत होती है।",
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
      pencil: "छोटी तो होती है — पर रोशनी नहीं देती।",
      पेंसिल: "छोटी तो होती है — पर रोशनी नहीं देती।",
      bulb: "बल्ब छोटा नहीं होता। और ये पिघलती है।",
      बल्ब: "बल्ब छोटा नहीं होता। और ये पिघलती है।",
      ice: "बर्फ़ छोटी होती है, पर अंधेरे में काम नहीं आती।",
      "बर्फ़": "बर्फ़ छोटी होती है, पर अंधेरे में काम नहीं आती।",
      matchstick: "क़रीब! पर ये देर तक जलती है, और पिघलती है।",
      माचिस: "क़रीब! पर ये देर तक जलती है, और पिघलती है।",
    },
    hints: [
      "ये मोम से बनती है और जलने पर पिघलती है।",
      "बर्थडे पर इसे बुझाते हैं।",
      "बिजली चली जाए तो ये काम आती है।",
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
