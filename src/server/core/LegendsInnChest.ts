import { Client } from './Client';
import { LegendsInn } from './LegendsInn';

/**
 * The gold chest behind each Legends' Inn stage boss, and what comes out of it.
 *
 * The chest is level art - a `ac_TreasureChest*` cue the SWF build places behind
 * the boss anchor - so breaking it is an ordinary client-side kill and the reward
 * arrives as an ordinary reward request. Everything about *what* it pays is
 * decided here instead of by the loot tables, because none of it is a roll:
 *
 *   - **Gold, every time, scaled by the stage.** A million times the stage number,
 *     to every player standing in the instance when the chest is opened, once per
 *     opening.
 *   - **Three catalysts, once a week each.** Heart of the Furnace, Dragonfire
 *     Talisman and Inventor's Trinket drop one at a time and then stop dropping
 *     for that character until the week turns over. The lock is per character and
 *     per catalyst, so a player who took the Heart on Monday still finds the other
 *     two waiting.
 *
 * ## Why the weekly lock is spent on the drop, not on the pickup
 *
 * Nine stages means nine chests in one run. If the lock were only taken when the
 * loot was picked up, a run would pay the same catalyst nine times over before the
 * first one was walked onto. It is claimed at the moment the loot is spawned, so
 * the first chest of the week carries the catalysts and the other eight carry
 * gold.
 *
 * ## The carrier
 *
 * The loot-drop packet (0x32) can describe gold, gear, a material, health or a
 * dye, and nothing else - there is no consumable slot in it, and catalysts are
 * consumables. So a catalyst rides down on a *carrier material* chosen to match
 * its rarity, and `RewardHandler.handlePickupLootdrop` grants the catalyst instead
 * of the material when it sees one. What the player walks over looks like a
 * legendary/rare/mystic drop and what lands in the bag is the catalyst.
 */

export interface LegendsInnWeeklyReward {
    /** `ConsumableTypes` id - what actually lands in the bag. */
    consumableId: number;
    /** Human name, for the log. */
    label: string;
    /**
     * The material the drop is *drawn* as on the ground. Picked for rarity colour:
     * Skull of the Gods is Legendary, Dragon Talon is Rare, Massive Scale is
     * Mystic, matching the three catalysts.
     */
    carrierMaterialId: number;
}

/** The catalysts, in the order they are laid out on the floor. */
export const LEGENDS_INN_WEEKLY_REWARDS: LegendsInnWeeklyReward[] = [
    { consumableId: 4, label: 'Heart of the Furnace', carrierMaterialId: 3 },
    { consumableId: 3, label: 'Dragonfire Talisman', carrierMaterialId: 2 },
    { consumableId: 1, label: "Inventor's Trinket", carrierMaterialId: 1 }
];

/**
 * The gold a stage-1 chest pays, and the step every stage after it adds.
 *
 * A chest pays `stage * this`, so Wolf's End is the million the dungeon was
 * specified around and Valhaven is nine - a full run is forty-five. Scaling by the
 * stage rather than paying a flat rate is what makes walking the whole road worth
 * more than farming the first chest, which matters here because every stage has
 * one and stage 1 is the cheapest to reach.
 *
 * Unlike the catalysts this is not on a weekly lock: it is paid by every chest,
 * every run.
 */
export const LEGENDS_INN_CHEST_GOLD_PER_STAGE = 1_000_000;

/** What the chest at the end of `stage` pays each player. */
export function getChestGold(stage: number): number {
    const index = Math.max(1, Math.round(Number(stage) || 1));
    return index * LEGENDS_INN_CHEST_GOLD_PER_STAGE;
}

/** Where the weekly claims live on the character. */
const CLAIM_FIELD = 'legendsInnWeeklyClaims';

/**
 * The week a moment belongs to, as `YYYY-Www`.
 *
 * Weeks start Monday 00:00 UTC. UTC rather than local time so a party spread
 * across time zones resets together, and a plain year-week string rather than a
 * timestamp so a stored claim is readable in a save file and cannot drift.
 */
export function getWeekKey(now: number = Date.now()): string {
    const date = new Date(now);
    // ISO-8601 week number: shift to the Thursday of this week, then count weeks
    // from the first Thursday of that year.
    const day = (date.getUTCDay() + 6) % 7;
    const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 3));
    const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
    const firstDay = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
    const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
    return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function readClaims(character: Record<string, unknown>): Record<string, string> {
    const stored = character[CLAIM_FIELD];
    return stored && typeof stored === 'object' && !Array.isArray(stored)
        ? (stored as Record<string, string>)
        : {};
}

/**
 * How far from its recorded point a chest may be and still be the stage chest.
 *
 * Generous, because the point compared against is whatever the client reported
 * for a body it spawned itself, but far smaller than the distance to any of the
 * dungeon's own chests - those are rooms away, not pixels.
 */
const CHEST_MATCH_RADIUS = 400;

export class LegendsInnChest {
    /**
     * True for the one chest this feature owns, in this stage.
     *
     * Matched on *position*, not on EntType. Several of the borrowed dungeons
     * place treasure chests of their own, and the SWF build renames chest classes
     * so that every stage can carry the large gold chest - which means the class
     * cannot tell ours from theirs. Where it stands can: the build records the
     * point it placed the chest on, and the dungeon's own chests are rooms away.
     */
    static isStageChest(levelName: string | null | undefined, entity: unknown): boolean {
        const stage = LegendsInn.getStage(levelName);
        if (!stage?.chest) {
            return false;
        }
        const record = entity as Record<string, unknown> | null;
        const name = String(record?.name ?? record?.EntName ?? record?.entName ?? '').trim();
        const behavior = String(record?.behavior ?? record?.Behavior ?? '').trim();
        if (!/treasurechest/i.test(name) && behavior !== 'TreasureChest') {
            return false;
        }

        const x = Number(record?.x ?? record?.pos_x ?? NaN);
        const y = Number(record?.y ?? record?.pos_y ?? NaN);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return false;
        }
        return Math.hypot(x - Number(stage.chest.x), y - Number(stage.chest.y)) <= CHEST_MATCH_RADIUS;
    }

    /**
     * Whether this character may still be paid `reward` this week, taking the
     * claim if so. Returns false once the week's copy has been handed out.
     */
    static claimWeekly(character: unknown, reward: LegendsInnWeeklyReward, now: number = Date.now()): boolean {
        const record = character as Record<string, unknown> | null;
        if (!record) {
            return false;
        }

        const week = getWeekKey(now);
        const claims = readClaims(record);
        if (claims[String(reward.consumableId)] === week) {
            return false;
        }
        claims[String(reward.consumableId)] = week;
        record[CLAIM_FIELD] = claims;
        return true;
    }

    /** What this character has left this week, without taking anything. */
    static getUnclaimedWeeklyRewards(character: unknown, now: number = Date.now()): LegendsInnWeeklyReward[] {
        const record = character as Record<string, unknown> | null;
        if (!record) {
            return [];
        }
        const week = getWeekKey(now);
        const claims = readClaims(record);
        return LEGENDS_INN_WEEKLY_REWARDS.filter((reward) => claims[String(reward.consumableId)] !== week);
    }

    /**
     * Everything one player should be paid for this chest opening, in the order it
     * is laid out on the floor. Claims are taken here, so calling this twice for
     * one opening pays the catalysts once.
     */
    static takePayout(client: Client, now: number = Date.now()): Array<{
        gold?: number;
        consumableId?: number;
        carrierMaterialId?: number;
        label: string;
    }> {
        // The stage is read from the level the recipient is standing in rather than
        // passed in, so a player who joined the run late is paid for the chest they
        // are actually at.
        const stage = Math.max(1, Math.round(Number(LegendsInn.getStage(client.currentLevel)?.stage ?? 1)));
        const gold = getChestGold(stage);
        const payout: Array<{ gold?: number; consumableId?: number; carrierMaterialId?: number; label: string }> = [
            { gold, label: `${gold.toLocaleString('en-US')} gold (stage ${stage})` }
        ];

        for (const reward of LEGENDS_INN_WEEKLY_REWARDS) {
            if (!LegendsInnChest.claimWeekly(client.character, reward, now)) {
                continue;
            }
            payout.push({
                consumableId: reward.consumableId,
                carrierMaterialId: reward.carrierMaterialId,
                label: reward.label
            });
        }
        return payout;
    }
}

/**
 * Which chest openings have already been paid.
 *
 * Keyed by level scope, then by the chest entity and the participant, because a
 * chest opening is reported by whichever client landed the killing blow and the
 * whole instance is paid - so the same opening arrives once and must fan out once.
 * Cleared with the scope, so the next run through the same instance pays again.
 */
const paidOpenings: Map<string, Set<string>> = new Map();

export function claimChestOpening(levelScope: string, openingKey: string): boolean {
    const scopeKey = String(levelScope ?? '');
    if (!scopeKey || !openingKey) {
        return false;
    }
    const paid = paidOpenings.get(scopeKey) ?? new Set<string>();
    if (paid.has(openingKey)) {
        return false;
    }
    paid.add(openingKey);
    paidOpenings.set(scopeKey, paid);
    return true;
}

export function resetChestOpenings(levelScope: string | null | undefined): void {
    paidOpenings.delete(String(levelScope ?? ''));
}
