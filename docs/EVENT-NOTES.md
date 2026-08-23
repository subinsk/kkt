# Event notes

Scraped from the Commudle listing plus the organiser's pre-event message.

## Logistics

- **Event:** Agora Solo Buildathon ("Build with Agora")
- **Organiser:** KNOTiC · **Sponsors:** Agora, Paytm, Vobiz AI
- **Date:** 23 August 2026, 9:00 AM – 5:30 PM IST
- **Venue:** Paytm, One Skymark, Tower D, Sector 98, Noida
- **Format:** solo, offline
- **Prizes:** $100 / $60 / $40

> **Date conflict:** the participant brief says *9 August 2026, 9:00 AM – 5:00 PM*.
> Commudle says *23 August, 9:00 AM – 5:30 PM*. Worth confirming.

## Agenda (IST)

| Time | Item |
| --- | --- |
| 9:00 – 9:45 | Registration and check-in |
| 9:50 – 10:05 | Opening keynote, KNOTiC |
| 10:05 – 10:15 | Introduction to Agora |
| 10:15 – 10:25 | Introduction to Vobiz AI |
| 10:25 – 12:50 | Build + mentorship, round 1 |
| 12:50 – 13:00 | Paytm engagement activity |
| 13:00 – 13:45 | Break |
| 13:45 – 15:00 | Build + mentorship, round 2 |
| 15:00 – 15:30 | **Submission deadline** |
| 15:30 – 16:15 | Finalist demos, pitches, jury Q&A |
| 16:15 – 17:00 | Winners and closing |

Commudle renders these in UTC; converted to IST above. **Effective build time
is roughly 4.5 hours across two blocks**, not eight — the brief's "8-hour"
framing includes keynotes, breaks and judging. Plan accordingly: the demo has
to be working by 15:00.

## Judges and speakers

Vikash Srivastava · Akshit Batra (Senior Consultant Developer, Thoughtworks) ·
Vaibhav Parmar · Anisha Sethi · Anand Gaur (Mobile Tech Lead) ·
Hitesh Das (Head of Engineering, OLX India) · Himanshu Gunwant ·
Ankur Agarwal (Lead, Technology)

Engineering leads, not product people. Expect questions about the pipeline,
latency and failure modes rather than market size.

## Extra opportunities

- Top projects showcased on **Agora Recipes**: https://recipes.agora.io/
- Selected write-ups featured on Agora's Medium publication and newsletter
- Tag [@agora-lab-inc](https://www.linkedin.com/company/agora-lab-inc/) on
  LinkedIn and [@AgoraIO](https://x.com/AgoraIO) on X when sharing

## Pre-event setup the organisers asked for

- **Web (recommended):** https://github.com/AgoraIO-Conversational-AI/agent-quickstart-nextjs
- Android (optional): https://github.com/AgoraIO-Conversational-AI/agent-quickstart-android
- ESP32 / hardware (optional): https://github.com/AgoraIO-Conversational-AI/esp32-client

## Organiser's steer on ideas

> "Don't feel limited by these demos though — the weirder and more creative the
> Voice AI idea, the better."

Inspiration demos they linked (worth skimming so you don't rebuild one):

- https://x.com/akshay81844/status/2088686040240599089
- https://x.com/akshay81844/status/2087127859504796049
- https://x.com/akshay81844/status/2086284541417984175
- https://x.com/akshay81844/status/2085532945360777381
- https://x.com/akshay81844/status/2070154180988395524
- https://x.com/akshay81844/status/2069983071408185642
- https://x.com/akshay81844/status/2069982266382803347
- https://x.com/akshay81844/status/2047516195537179044
- https://x.com/zicojzc/status/2090788151430443305
- https://x.com/zicojzc/status/2090013654712553821
- https://x.com/zicojzc/status/2084239828661555270
- https://x.com/zicojzc/status/2081950728315404354

## How the official quickstart differs from this repo

| | Quickstart | This repo |
| --- | --- | --- |
| Data channel | RTM (needs combined RTC+RTM token) | RTC datastream (RTC token only) |
| LLM | Agora calls the provider directly | Proxied through `/api/llm` so tools execute |
| Extras | Agent UIKit visualiser, `AGENT_METRICS` | Tool loop, actions panel, case store |

The UIKit visualiser and metrics are worth lifting from the quickstart if you
want a slicker demo surface. Switching to RTM also unlocks `enable_metrics`
and `enable_error_message`.
