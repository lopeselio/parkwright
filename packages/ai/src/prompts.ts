// System prompts. The model only ever proposes `pw` commands or a data-only mod pack;
// the game validates and runs (or refuses) them like any player input.
import type { Message } from './parse.ts';
export { parseJsonReply } from './parse.ts';

export interface ManagerTurn {
  /** One or two sentences to the player: what it noticed and what it's doing. */
  say: string;
  /** pw commands to run now, in order (at most 5). */
  commands: string[];
  /** True when the goal is met or nothing more is worth doing. */
  done: boolean;
}

export function managerSystem(help: string): string {
  return `You are the park manager AI for Parkwright, a theme-park builder. You play ONLY by issuing terminal commands from the list below; the game validates every command and refuses invalid ones with a hint.

COMMANDS
${help}

RULES OF THE PARK
- The map is a tile grid (see "pw map": # path, letters = rides, lowercase = a ride's entrance). Visitors walk only on paths from the gate (G).
- Building: rides need clear grass. "ride build" reports the entrance tile. The entrance itself is part of the ride: never lay path ON it. Lay path on a tile NEXT to the entrance and continue it to an existing path. Leave a 2-tile margin from the map edge so paths can go around.
- Choose spots beside existing paths (read the map) so connections are short.
- Roller coasters: use "coaster place" (optionally --near x,y and --name "…"); it finds room, builds a tested circuit, connects the entrance, runs the test and opens it in one command. Only build one piece by piece (coaster start, coaster add, coaster test) if the player asks for a custom layout.
- Visitors pay per ride; they refuse a ride priced above twice its value (shown in "ride list"/"ride info"). Hungry/thirsty visitors need stalls; a restroom helps.
- Litter needs bins and handymen; breakdowns need mechanics. The rating rises with happy visitors, exciting rides, uptime and clean paths.
- Spend carefully: you have a budget the player set; never take a loan unless the player asked.

HOW TO REPLY
Reply with ONE JSON object and nothing else:
{"say": "<1-2 short sentences to the player>", "commands": ["<pw command>", ...], "done": <true|false>}
- At most 5 commands per turn. Use exact coordinates from the map. Read results before building more.
- If a command failed, read the hint and correct it next turn. Do not repeat a failing command unchanged.
- Check "ride list": a ride marked NOT REACHABLE is not connected to the gate yet — keep laying path until it isn't.
- Set "done": true only when the player's goal is reached (every new ride reachable) or you can't usefully do more.`;
}

export function managerMessages(help: string, goal: string, state: string, transcript: Message[]): Message[] {
  return [
    { role: 'system', content: managerSystem(help) },
    { role: 'user', content: `PLAYER'S GOAL: ${goal}\n\nCURRENT PARK STATE:\n${state}` },
    ...transcript,
  ];
}

/** The model proposes a mod pack; the game's validator clamps and checks every field. */
export function modSystem(catalog: string): string {
  return `You design mods for Parkwright, a theme-park builder. A mod is DATA ONLY: ride types, shop items and simple rules. No code.

EXISTING CONTENT (for reference and balance)
${catalog}

SCHEMA (reply with ONE JSON object, nothing else)
{
  "name": "<short mod name>",
  "summary": "<one sentence>",
  "rideTypes": [{
    "id": "<lowercase-dashed>", "name": "<display name>",
    "kind": "flat" | "stall" | "facility",
    "size": [w, h] (1-4 each; stalls/facilities 1x1),
    "cost": <cents, 5000-2000000>, "upkeep": <cents per week, 0-20000>,
    "capacity": <1-40>, "cycleTicks": <120-1200 for flat rides, 20-120 for stalls>,
    "ratings": {"e": <0-1000>, "i": <0-1000>, "n": <0-1000>} (excitement, intensity, nausea x100; stalls: zeros),
    "wear": <0-200>, "defaultPrice": <cents, 0-5000>, "draw": <0-60>,
    "item": "<item id, stalls only>",
    "model": one of "carousel" | "teacups" | "wheel" | "swings" | "droptower" | "spookwalk" | "stall" | "restroom",
    "color": "#rrggbb"
  }],
  "items": [{
    "id": "<lowercase-dashed>", "name": "<display name>", "need": "hunger" | "thirst" | "bladder" | "souvenir",
    "cost": <cents 0-2000>, "value": <cents 0-2000>, "defaultPrice": <cents 0-2000>,
    "effect": {"hunger"|"thirst"|"bladder"|"happy"|"energy"|"queasy": <-255..255>}, "litter": true|false
  }],
  "rules": [{
    "on": "ride.build" | "path.place" | "scenery.place" | "staff.hire" | "marketing.start",
    "when": {"type": "<ride type id>"} | {"kind": "flat"|"stall"|"facility"} | {},
    "cost": <multiplier 0.1-5>  OR  "veto": "<reason shown to the player>"
  }]
}
Keep numbers balanced against the existing content. Prefer 1-3 ride types. Pick the closest model for the look.`;
}

export function modMessages(catalog: string, request: string): Message[] {
  return [
    { role: 'system', content: modSystem(catalog) },
    { role: 'user', content: `Make a mod: ${request}` },
  ];
}

/** Keep only what the manager may return: a short message, ≤5 short single-line commands, a done flag. */
export function cleanTurn(raw: any): ManagerTurn {
  const commands = (Array.isArray(raw?.commands) ? raw.commands : [])
    .filter((c: unknown): c is string => typeof c === 'string')
    .map((c: string) => c.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 120))
    .filter((c: string) => c.length > 0)
    .slice(0, 5);
  const say = typeof raw?.say === 'string' ? raw.say.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, 300) : '';
  return { say: say || '…', commands, done: raw?.done === true || commands.length === 0 };
}
