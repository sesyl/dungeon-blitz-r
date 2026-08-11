import { Client } from './Client';
import { LegendsInn } from './LegendsInn';

/**
 * What the things standing in Legends' Inn say.
 *
 * The nine stages are borrowed dungeons, and a borrowed dungeon comes with its
 * own dialogue: the room scripts still fire the lines Wolf's End's goblins and
 * Shazari's raptors were written to shout, and the Dread Rogues that replaced
 * them were shouting them. This module rewrites those lines into the one story
 * the dungeon is actually about.
 *
 * ## The story
 *
 * Telahair was a Rogue who stood at the front of his people's battles until the
 * wounds and the tiredness outlasted the war. Nephit offered him a bargain -
 * Nephit's guardians would never again cross into the land Telahair defended -
 * and Telahair, who trusted him, took it. The bargain was a trap. Nephit wanted
 * more than a border, and the spell he worked on Telahair left him something else
 * entirely: a thing that no longer knows its own people. Nephit's guardians did
 * not leave either; they spread out through nine holds instead. So the ones who
 * still have the stomach for it come to Legends' Inn to end it.
 *
 * ## How a line is chosen
 *
 * The room's *event* is kept and only the words are replaced, which is what makes
 * this possible without touching a single room script: the level still decides
 * when a hostile speaks, at the moment it was authored to.
 *
 * Which line comes out is a stable hash of the speaker's EntType and the line it
 * was going to say. That gives three things at once - two different mobs never say
 * the same thing, a mob with several authored lines still says several different
 * things, and the same mob says the same thing every run, so the dungeon can be
 * learned rather than re-rolled.
 *
 * Lines are grouped by where in the tour they are heard: the early stages are
 * rumour, the middle ones are the bargain, the last three are what he became.
 * Bosses get their own pool, because a boss speaks as one of Nephit's guardians
 * rather than about them.
 *
 * ## Language
 *
 * English, delivered as written. Unlike the borrowed dungeons' own dialogue these
 * lines skip `DialogueTranslationLoader` entirely - see the call site in
 * `SocialHandler.translateRoomThought`. That is not just a preference: an enemy
 * line the translator cannot match falls through to `fallbackToGeneric`, which
 * would answer one of these story beats with a canned taunt.
 */

/** Stage 1-3: nobody in here knows the whole of it yet. */
const RUMOUR_LINES: string[] = [
    "You walk the road Telahair walked. It ends the same way.",
    "He was a hero once. Ask anyone still alive who remembers.",
    "Nephit came to him with an offer. He should have run.",
    "The banners you see rotting here were his.",
    "We were his people. He does not know us now.",
    "Turn back. What waits at the end of this inn is not a man.",
    "Telahair carried our shields for twenty winters.",
    "The bargain was struck in this hold. The rot started here.",
    "Nine holds, nine locks. He is behind the last of them.",
    "They say he asked only for peace. They say Nephit smiled.",
    "You will not save him. Nobody has.",
    "He gave everything for the border. Nephit took the rest."
];

/** Stage 4-6: the bargain itself, and who profited from it. */
const BARGAIN_LINES: string[] = [
    "The terms were simple: Nephit's guardians would never cross his border.",
    "Nephit kept the letter of it. We were never sent across. We were sent here.",
    "He trusted Nephit. That was the whole of the trap.",
    "A war-weary man will sign anything for one quiet season.",
    "The wounds did what no enemy could. Then Nephit did the rest.",
    "Nephit wanted more than a border, and he wrote it in small letters.",
    "We are the guardians he bargained away. Look how far we spread.",
    "There was a spell under the ink. He never read that far.",
    "He asked for his people's safety. He did not ask for his own.",
    "Every hold you have walked is a clause in that contract.",
    "The bargain held. It simply was not the bargain he made.",
    "He signed as a Rogue. He rose as something Nephit owned."
];

/** Stage 7-9: what the spell left behind. */
const RUIN_LINES: string[] = [
    "He is close now. Do not expect him to know your face.",
    "The spell took his people from him first. Then it took him.",
    "He guards Nephit's work with the same arms he raised against it.",
    "Call his name if you like. It is not his any more.",
    "What is left of Telahair does not remember the border it died for.",
    "Nephit's guardians are only his jailers. He is the cell.",
    "He killed his own captains and did not stop to look.",
    "You are the last of the brave ones to try this. There were many.",
    "He was the shield of a country. Now he is the lock on a door.",
    "Nothing of the man is answering. Only what was put in his place.",
    "Turn back while your own name still fits you.",
    "The end of the inn is his. Nothing walks out of it."
];

/** What Nephit's guardians say when they are the thing you have come to kill. */
const BOSS_LINES: string[] = [
    "Nephit set me here to keep his prize. You are not taking it.",
    "Telahair's chains run through me. Break me and one link gives.",
    "I was promised a border to guard. I was given a corpse to watch.",
    "You reek of the courage he had once. It did not help him either.",
    "Nephit's word is kept in blood. Yours is about to pay for it.",
    "Every one of us is a clause. Kill enough and the contract fails.",
    "He begged for his people at the end. Nephit let him finish.",
    "You will reach him. You will wish you had not.",
    "I have held this hold since the ink dried. You will not be the one.",
    "Go on to the next lock. Something worse is holding it."
];

/** Which pool a stage draws from. */
function poolForStage(stage: number): string[] {
    if (stage <= 3) return RUMOUR_LINES;
    if (stage <= 6) return BARGAIN_LINES;
    return RUIN_LINES;
}

/**
 * A stable, well-spread index for a pair of strings.
 *
 * FNV-1a rather than anything cleverer: it only has to be deterministic across
 * restarts and to scatter neighbouring inputs, and two EntTypes in one stage
 * usually differ only in a trailing digit.
 */
function hashIndex(...parts: string[]): number {
    let hash = 0x811c9dc5;
    for (const part of parts) {
        for (let index = 0; index < part.length; index += 1) {
            hash ^= part.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        hash = Math.imul(hash ^ 0x5f, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

function normalizeName(value: unknown): string {
    return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The EntType a speaking entity is, as this session knows it. */
function speakerName(client: Client, entityId: number): string {
    const entity = client.entities?.get(entityId) as Record<string, unknown> | undefined;
    return String(entity?.name ?? entity?.EntName ?? entity?.entName ?? '').trim();
}

export class LegendsInnDialogue {
    /**
     * The line a Legends' Inn hostile should say instead of the one its room
     * script asked for, or null if this is not a line to rewrite.
     *
     * Players are left alone - the same packet carries a player's own chat bubble
     * in a cutscene - and so is anything the session cannot name, because a line
     * with no speaker cannot be given a speaker's voice.
     */
    static resolveLine(client: Client, entityId: number, authoredText: string): string | null {
        const stageInfo = LegendsInn.getStage(client?.currentLevel);
        if (!stageInfo) {
            return null;
        }

        const name = speakerName(client, entityId);
        if (!name) {
            return null;
        }
        const entity = client.entities?.get(entityId) as Record<string, unknown> | undefined;
        if (entity?.isPlayer) {
            return null;
        }

        const isBoss = stageInfo.bosses.some((boss) => normalizeName(boss) === normalizeName(name));
        const pool = isBoss ? BOSS_LINES : poolForStage(Math.max(1, Math.round(Number(stageInfo.stage) || 1)));
        // The stage is part of the key so the same EntType, reused two stages
        // apart, does not repeat itself word for word.
        const index = hashIndex(stageInfo.levelName, name, String(authoredText ?? ''));
        return pool[index % pool.length];
    }

    /** Every line this module can produce, for the translation tooling. */
    static getAllLines(): string[] {
        return [...RUMOUR_LINES, ...BARGAIN_LINES, ...RUIN_LINES, ...BOSS_LINES];
    }
}
