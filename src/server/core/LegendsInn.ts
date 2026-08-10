import * as fs from 'fs';
import * as path from 'path';
import { Client } from './Client';
import { EntityProps, EntityState, EntityTeam } from './Entity';
import { GlobalState } from './GlobalState';
import { LevelConfig } from './LevelConfig';
import { getClientLevelScope, getScopeLevelName } from './LevelScope';

/**
 * Legends' Inn: the exit portal, and the door behind it.
 *
 * Legends' Inn is nine dungeons walked end to end, so eight of its nine stages
 * need a way onward that is *earned* rather than standing there from the moment
 * the room loads. The rule the whole file exists to enforce is one sentence: the
 * portal out of a stage does not exist until that stage's boss is dead.
 *
 * How it is built, and why it is built this way:
 *
 *   - **The portal is a server-spawned entity, not level art.** A level SWF has
 *     no way to reveal a child of a room part-way through a run - a room's
 *     children are constructed once, on load - but the server can push an entity
 *     into a level scope whenever it likes. So the stage SWF carries only the
 *     door, which is an editor marker and is drawn hidden, and the thing the
 *     player sees arrives on the boss's death packet.
 *   - **That also settles the name plate.** A door with artwork under it carries
 *     the floating plate naming where it leads, which is exactly what a dungeon
 *     that pretends to be one place must not show. An entity carries only its
 *     EntType's DisplayName, and LEGENDS_INN_PORTAL_ENT deliberately has none.
 *   - **And the animation comes free**: the EntType is drawn from
 *     `Animation_Nephit.swf/a__NephitPortal`, a looping rift, the same art the
 *     Astral Rifts in Deepgard use.
 *
 * The door itself is refused until the portal is open. Opening is per *level
 * scope*, not per player, because a stage is walked as a party: whoever lands the
 * killing blow opens it for everyone standing in that instance, and anyone who
 * joins or reconnects afterwards is handed the portal on arrival.
 *
 * Everything positional here - which door id the exit landed on, where it stands,
 * and what the stage's boss is now called - is read out of the file
 * build-legends-inn-stages.ts writes, so there is only ever one description of a
 * stage and it is the one the SWF was actually built from.
 */

export interface LegendsInnStageInfo {
    levelName: string;
    region: string;
    stage: number;
    exitDoorId: number;
    returnDoorId: number;
    monsterBonusLevels: number;
    portal: { x: number; y: number };
    bosses: string[];
    enemies: string[];
}

/**
 * Entity ids for the portals.
 *
 * Authored level entity ids in this project top out around 14.4M and the keep
 * statues took 26M, so this block collides with nothing. One id per stage, fixed,
 * so a re-send replaces the portal in place instead of stacking a second one.
 */
const PORTAL_ENTITY_ID_BASE = 27_000_000;

export class LegendsInn {
    private static stagesByLevel: Map<string, LegendsInnStageInfo> = new Map();
    private static portalEntName = 'LegendsInnPortal';
    /** Level scopes whose boss is down. Cleared when the scope's run is reset. */
    private static openScopes: Set<string> = new Set();

    static load(dataDir: string): void {
        LegendsInn.stagesByLevel.clear();
        LegendsInn.openScopes.clear();

        const filePath = path.join(dataDir, 'legends_inn_stages.json');
        if (!fs.existsSync(filePath)) {
            // The dungeon simply is not built in this checkout; every entry point
            // below is a no-op, and nothing else in the server depends on it.
            console.log('[LegendsInn] legends_inn_stages.json not found; portals disabled.');
            return;
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '')) as {
                portalEnt?: string;
                stages?: LegendsInnStageInfo[];
            };

            LegendsInn.portalEntName = String(parsed.portalEnt ?? LegendsInn.portalEntName);
            for (const stage of parsed.stages ?? []) {
                const levelName = LevelConfig.normalizeLevelName(stage.levelName) || String(stage.levelName ?? '');
                if (!levelName) {
                    continue;
                }
                LegendsInn.stagesByLevel.set(levelName, { ...stage, levelName });
            }
            console.log(`[LegendsInn] Loaded ${LegendsInn.stagesByLevel.size} stages.`);
        } catch (err) {
            console.error('[LegendsInn] Failed to load legends_inn_stages.json:', err);
        }
    }

    static getStage(levelName: string | null | undefined): LegendsInnStageInfo | null {
        const normalized = LevelConfig.normalizeLevelName(levelName) || String(levelName ?? '').trim();
        return LegendsInn.stagesByLevel.get(normalized) ?? null;
    }

    static isStageLevel(levelName: string | null | undefined): boolean {
        return LegendsInn.getStage(levelName) !== null;
    }

    /**
     * How many levels this stage's monsters are lifted by, for `mBonusLevels`.
     *
     * This is the only number that decides how much health a hostile in here
     * actually has. The client sizes a client-spawned hostile in
     * `Entity.method_986` as
     * `HOSTILE_BASE_HP[entType.Level + mBonusLevels] * entType.HitPoints`, and
     * `mBonusLevels` reaches it in the player-data packet. Without it a stage-1
     * mob fights at the level it was authored for - a Dog Packmate at 2,036 hit
     * points - however the level is configured on the server.
     *
     * Zero for every level that is not a Legends' Inn stage, so nothing else in
     * the game changes: the shipped Dread dungeons keep the behaviour they have
     * today rather than silently gaining the jump their config implies.
     */
    static getMonsterBonusLevels(levelName: string | null | undefined): number {
        const stage = LegendsInn.getStage(levelName);
        return stage ? Math.max(0, Math.round(Number(stage.monsterBonusLevels) || 0)) : 0;
    }

    /**
     * The level the dungeon *presents* as, given the bonus its monsters carry.
     *
     * The entry plate reads `mapLevel + mBonusLevels` (class_100), so a stage that
     * lifts its monsters by 40 would announce itself as level 90. Taking the bonus
     * back out here leaves the plate showing the level the dungeon really is.
     *
     * Anchored to the level's own `baseId` rather than to the party level a
     * dungeon normally reports: Legends' Inn is a level-50 dungeon whoever walks
     * in, and its monsters are lifted to 50 regardless, so the plate must not
     * follow the party down.
     */
    static adjustDisplayMapLevel(levelName: string | null | undefined, mapLevel: number): number {
        const bonus = LegendsInn.getMonsterBonusLevels(levelName);
        if (bonus <= 0) {
            return mapLevel;
        }
        return Math.max(1, Math.round(LevelConfig.get(LevelConfig.normalizeLevelName(levelName) || '').baseId) - bonus);
    }

    /** True once this instance's boss is down and the way onward is open. */
    static isPortalOpen(levelScope: string | null | undefined): boolean {
        return LegendsInn.openScopes.has(String(levelScope ?? ''));
    }

    /**
     * Whether a door may be used.
     *
     * Only the *exit* door is gated. The door a stage was entered through stays
     * usable throughout, so a party that bites off more than it can chew is never
     * sealed in - that door leads back to Craft Town, not deeper into the run.
     */
    static isDoorUnlocked(client: Client, doorId: number): boolean {
        const stage = LegendsInn.getStage(client?.currentLevel);
        if (!stage || Math.round(Number(doorId)) !== stage.exitDoorId) {
            return true;
        }
        return LegendsInn.isPortalOpen(getClientLevelScope(client));
    }

    /**
     * A hostile died somewhere. Opens the portal if it was this stage's boss.
     *
     * The name is compared the way the rest of the server compares entity names -
     * case- and punctuation-insensitively - because a hostile reaches here having
     * been round-tripped through the client's cue, and a stage may legitimately
     * have more than one boss (Bridgetown's twins), in which case any of them
     * opening the way is the authored behaviour: the room is clear either way.
     */
    static noteEntityDefeated(client: Client, entity: unknown): void {
        const stage = LegendsInn.getStage(client?.currentLevel);
        if (!stage) {
            return;
        }

        const name = LegendsInn.normalizeName(
            (entity as Record<string, unknown> | null)?.name ??
            (entity as Record<string, unknown> | null)?.EntName ??
            (entity as Record<string, unknown> | null)?.entName
        );
        if (!name || !stage.bosses.some((boss) => LegendsInn.normalizeName(boss) === name)) {
            return;
        }

        LegendsInn.openPortal(getClientLevelScope(client), stage);
    }

    /**
     * Opens the way out of a stage for everyone standing in it.
     *
     * Idempotent on the scope, so a boss whose death is reported by several
     * clients - the normal case in a party - spawns one portal, once.
     */
    static openPortal(levelScope: string, stage: LegendsInnStageInfo): void {
        const scopeKey = String(levelScope ?? '');
        if (!scopeKey || LegendsInn.openScopes.has(scopeKey)) {
            return;
        }

        LegendsInn.openScopes.add(scopeKey);
        console.log(`[LegendsInn] ${stage.levelName} portal opened for scope ${scopeKey}`);

        for (const session of GlobalState.getSessionsInLevelScope(scopeKey)) {
            LegendsInn.sendPortal(session, stage);
        }
    }

    /**
     * Hands the portal to one session, if its stage has already been cleared.
     *
     * Called on every arrival, which is what covers the two cases the death
     * broadcast cannot: a party member who was still loading when the boss fell,
     * and a player who disconnects after the kill and comes back to a run that is
     * already open.
     */
    static onPlayerSpawned(client: Client): void {
        const stage = LegendsInn.getStage(client?.currentLevel);
        if (!stage || !LegendsInn.isPortalOpen(getClientLevelScope(client))) {
            return;
        }
        LegendsInn.sendPortal(client, stage);
    }

    /**
     * Forgets a scope's progress.
     *
     * A level scope is reused when a fresh run starts in the same instance, and a
     * stage whose portal is remembered from the last run would let the next party
     * walk straight past its boss.
     */
    static resetScope(levelScope: string | null | undefined): void {
        LegendsInn.openScopes.delete(String(levelScope ?? ''));
    }

    /** Drops every scope of a level. Used when the last player leaves an instance. */
    static resetLevel(levelName: string | null | undefined): void {
        const normalized = LevelConfig.normalizeLevelName(levelName) || String(levelName ?? '').trim();
        if (!normalized) {
            return;
        }
        for (const scopeKey of [...LegendsInn.openScopes]) {
            if (getScopeLevelName(scopeKey) === normalized) {
                LegendsInn.openScopes.delete(scopeKey);
            }
        }
    }

    static getPortalEntityId(stage: LegendsInnStageInfo): number {
        return PORTAL_ENTITY_ID_BASE + Math.max(1, Math.round(Number(stage.stage) || 1));
    }

    static isPortalEntityId(entityId: unknown): boolean {
        const id = Math.round(Number(entityId ?? 0));
        return id > PORTAL_ENTITY_ID_BASE && id <= PORTAL_ENTITY_ID_BASE + 999;
    }

    /**
     * The portal entity.
     *
     * Team 3 - the neutral/NPC team - rather than ENEMY, so nothing targets it
     * and no brain ever picks a fight with it, and `untargetable` on top of that
     * so a stray cleave cannot either. It stands in the ACTIVE state because its
     * EntType's animation is its idle: a SLEEP-state entity is handed its (empty)
     * sleep cue and stops moving, which is the one thing this entity is for.
     */
    static buildPortalEntity(stage: LegendsInnStageInfo): EntityProps & Record<string, unknown> {
        const entityId = LegendsInn.getPortalEntityId(stage);
        return {
            id: entityId,
            name: LegendsInn.portalEntName,
            isPlayer: false,
            x: stage.portal.x,
            y: stage.portal.y,
            spawnX: stage.portal.x,
            spawnY: stage.portal.y,
            spawnEntState: EntityState.ACTIVE,
            v: 0,
            team: EntityTeam.NPC,
            renderDepthOffset: 0,
            characterName: '',
            dramaAnim: '',
            sleepAnim: '',
            summonerId: 0,
            powerId: 0,
            entState: EntityState.ACTIVE,
            facingLeft: false,
            running: false,
            jumping: false,
            dropping: false,
            backpedal: false,
            untargetable: true,
            healthDelta: 0,
            buffs: [],
            roomId: -1,
            // Server-owned: neither a client spawn nor a session's own entity, so
            // the ownership sweeps that follow players between scopes leave it be.
            clientSpawned: false,
            legendsInnPortal: true
        };
    }

    private static sendPortal(client: Client, stage: LegendsInnStageInfo): void {
        if (!client?.playerSpawned) {
            return;
        }

        const entityId = LegendsInn.getPortalEntityId(stage);
        if (client.knownEntityIds.has(entityId)) {
            return;
        }

        const props = LegendsInn.buildPortalEntity(stage);
        client.entities.set(entityId, { ...props });
        // Imported lazily: EntityHandler pulls in most of the handler layer, and
        // this module is loaded by LevelConfig-time bootstrap.
        const { EntityHandler } = require('../handlers/EntityHandler') as typeof import('../handlers/EntityHandler');
        EntityHandler.sendEntity(client, props);
    }

    private static normalizeName(value: unknown): string {
        return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    }
}
