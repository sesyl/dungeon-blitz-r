import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
import { getLevelScopeKey } from '../core/LevelScope';
import {
    getOrCreateSharedDungeonProgressState,
    getSharedDungeonProgressTotals,
    recomputeSharedDungeonProgress,
    usesSharedDungeonProgress
} from '../core/SharedDungeonProgress';
import { DungeonSpawnLoader, DungeonSpawnConfig } from '../data/DungeonSpawnLoader';
import { NpcLoader } from '../data/NpcLoader';
import { CombatHandler } from '../handlers/CombatHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

// The East Wing's four rooms author 34 hostiles plus the room-3 boss. This was 5 for as
// long as the extractor discovered enemies from each room's declared ActionScript fields,
// which only see a cue the level author bothered to name -- 30 of the 35 are unnamed
// timeline instances. If this number moves, regenerate the registry and check why.
const EAST_WING_ENEMY_COUNT = 35;

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    character: { name: string; level: number; class?: string; MasterClass?: number; CurrentLevel?: { name: string; x: number; y: number } };
    currentLevel: string;
    levelInstanceId: string;
    syncAnchorStartedAt: number;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    userId: number;
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
    knownEntityIds: Set<number>;
    entityIdAliases: Map<number, number>;
    sharedEntityRemoteUpdateDeferredIds: Set<number>;
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('JC_Mini2')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
    if (NpcLoader.getRawNpcsForLevel('JC_Mini2').length === 0) {
        NpcLoader.load(dataDir);
    }
}

function getConfig(): DungeonSpawnConfig {
    const config = DungeonSpawnLoader.getSpawnConfigForLevel('JC_Mini2');
    assert.ok(config, 'East Wing generated dungeon spawn config should load');
    return config as DungeonSpawnConfig;
}

function createFakeClient(name: string, instanceId: string, token: number, roomId: number): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        token,
        character: {
            name,
            level: 50,
            class: 'mage',
            MasterClass: 0,
            CurrentLevel: { name: 'JC_Mini2', x: 100, y: 200 }
        },
        currentLevel: 'JC_Mini2',
        levelInstanceId: instanceId,
        syncAnchorStartedAt: token,
        currentRoomId: roomId,
        playerSpawned: true,
        clientEntID: token + 1000,
        userId: token,
        authoritativeMaxHp: 5000,
        authoritativeCurrentHp: 5000,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function attachPlayer(client: FakeClient): void {
    const scope = getLevelScopeKey(client.currentLevel, client.levelInstanceId);
    const player = {
        ...Entity.fromCharacter(client.clientEntID, client.character as any, {
            x: 100,
            y: 200,
            team: EntityTeam.PLAYER,
            entState: EntityState.ACTIVE,
            roomId: client.currentRoomId
        }),
        ownerToken: client.token,
        ownerUserId: client.userId,
        hp: client.authoritativeCurrentHp,
        maxHp: client.authoritativeMaxHp
    };
    client.entities.set(client.clientEntID, player);
    client.knownEntityIds.add(client.clientEntID);

    let levelMap = GlobalState.levelEntities.get(scope);
    if (!levelMap) {
        levelMap = new Map<number, any>();
        GlobalState.levelEntities.set(scope, levelMap);
    }
    levelMap.set(client.clientEntID, player);
}

function setParty(...clients: FakeClient[]): void {
    const partyId = 8802;
    const members = clients.map((client) => client.character.name);
    for (const client of clients) {
        GlobalState.partyByMember.set(client.character.name.toLowerCase(), partyId);
    }
    GlobalState.partyGroups.set(partyId, {
        id: partyId,
        leader: members[0],
        members,
        locked: false
    });
}

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number, powerId: number = 77): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod24(damage);
    bb.writeMethod4(powerId);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildClientHostileFullUpdate(
    entityId: number,
    name: string,
    x: number,
    y: number,
    roomId: number
): Buffer {
    const payload = (EntityHandler as any).buildEntityFullUpdatePayload({
        id: entityId,
        name,
        isPlayer: false,
        x,
        y,
        v: 0,
        team: EntityTeam.ENEMY,
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
        roomId
    });
    return Buffer.concat([payload, Buffer.from([0])]);
}

function parseHpDelta(payload: Buffer): { entityId: number; delta: number } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        delta: br.readMethod45()
    };
}

function parseDestroy(payload: Buffer): { entityId: number; immediate: boolean } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        immediate: br.readMethod15()
    };
}

function getHostiles(scope: string): any[] {
    return Array.from(GlobalState.levelEntities.get(scope)?.values() ?? [])
        .filter((entity) => !entity.isPlayer && Number(entity.team ?? 0) === EntityTeam.ENEMY);
}

function attachProxy(client: FakeClient, localId: number, enemyIndex: number): void {
    const enemy = getConfig().enemies[enemyIndex];
    EntityHandler.handleEntityFullUpdate(
        client as never,
        buildClientHostileFullUpdate(
            localId,
            String(enemy.type),
            Number(enemy.x),
            Number(enemy.y),
            Number(enemy.roomId ?? 0)
        )
    );
}

function assertAllCanonicalHostiles(scope: string): void {
    const hostiles = getHostiles(scope);
    assert.equal(hostiles.length, EAST_WING_ENEMY_COUNT, 'JC_Mini2 should seed every authored cue as a canonical hostile');
    // The run is fought at the highest player level in the party, and that one number is
    // shared by everyone in it -- so a level 22 and a level 50 see the same enemy with the
    // same health pool, and it dies at the same moment on both screens.
    const partyLevel = EntityHandler.resolveServerAuthorityEntityLevel(scope);
    assert.equal(partyLevel, 50, 'a level 50 party fights level 50 enemies');
    for (const hostile of hostiles) {
        assert.equal(hostile.clientSpawned, false, `${hostile.name} should be server canonical`);
        assert.equal(hostile.level, partyLevel, `${hostile.name} should carry the party's tier`);
        assert.equal(hostile.requiredForClear, true, `${hostile.name} should be required for clear`);
        assert.equal(hostile.generatedFromScript, true, `${hostile.name} should be marked as script-generated`);
        assert.ok(String(hostile.spawnKey ?? '').includes('the_east_wing'), `${hostile.name} should keep a stable East Wing spawn key`);
        assert.equal(
            Number(hostile.maxHp ?? 0),
            EntityHandler.estimateServerAuthorityHostileMaxHp(hostile, scope),
            `${hostile.name} should be sized from the dungeon tier`
        );
        assert.ok(Number(hostile.maxHp ?? 0) > 100, `${hostile.name} should have a health pool`);
    }

    const boss = GlobalState.levelEntities.get(scope)?.get(920004);
    assert.equal(Boolean(boss?.roomBoss), true, 'TowerGuard2 should be marked as a room boss');
    assert.equal(boss?.displayName, 'Tanja, The 2nd Daughter', 'TowerGuard2 display name should come from InitRoom');
}

function testRegistryLoad(): void {
    const config = getConfig();
    assert.equal(config.source?.swf, 'src/client/content/localhost/p/cbp/LevelsJC.swf', 'registry should identify the source SWF');
    assert.equal(config.enemies.length, EAST_WING_ENEMY_COUNT, 'registry should contain every authored enemy');
    assert.equal(config.enemies.filter((enemy) => enemy.requiredForClear).length, EAST_WING_ENEMY_COUNT, 'all East Wing enemies should be required for clear');
    assert.equal(config.enemies.filter((enemy) => enemy.boss || enemy.miniboss).length, 1, 'registry should identify one boss/miniboss');

    const npcs = NpcLoader.getNpcsForLevel('JC_Mini2');
    assert.equal(npcs.length, EAST_WING_ENEMY_COUNT, 'NpcLoader should expose the generated East Wing enemies');
    assert.equal(npcs[0].id, 920001, 'generated canonical ids should be stable');
    assert.equal(usesSharedDungeonProgress('JC_Mini2'), true, 'generated required-for-clear dungeon should use shared progress');
}

// Drawing them once is not enough. sendInitialLevelEntities fires once per level entry, so a
// hostile a client misses in that burst is gone for the rest of the run -- reported live as
// "some enemies are missing", and as one player seeing an enemy the other does not.
//
// The retry must not be gated on the server's own bookkeeping: the send path fills
// viewer.entities itself, so the server always believes it drew the entity. That is why this
// asserts a re-send for a hostile the viewer is still recorded as holding.
// A dungeon must open at 0%. The tracked/defeated sets only ever grew, so a scope seeded more
// than once kept counting hostiles that no longer exist with the old ones still marked defeated
// -- reported live as a run opening at 50% with nothing killed, then diverging to 75%.
function testStaleTrackedHostilesDoNotInflateProgress(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-stale', 13991, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    // Seed the state the way a previous run left it: ids that are gone, all "defeated".
    const state = getOrCreateSharedDungeonProgressState(scope);
    assert.ok(state, 'shared progress state should exist');
    for (let index = 0; index < EAST_WING_ENEMY_COUNT; index += 1) {
        const staleId = 990_000 + index;
        state.trackedHostileIds?.add(staleId);
        state.defeatedHostileIds?.add(staleId);
    }

    const totals = getSharedDungeonProgressTotals(scope);
    assert.equal(totals.total, EAST_WING_ENEMY_COUNT, 'only the hostiles this run actually has should be tracked');
    assert.equal(totals.defeated, 0, 'stale ids from an earlier seeding must not count as defeats');
    assert.equal(recomputeSharedDungeonProgress(scope)?.progress, 0, 'a fresh East Wing run must open at 0%');
}

function testMissingDrawnHostilesAreRedrawn(): void {
    // Inert while the server does not draw these hostiles: reconcileDrawnHostilesForScope
    // returns immediately for any level that is not canonical-visible. Asserting that keeps
    // the guard honest -- re-enabling server-drawn hostiles must not silently start
    // duplicating the client's own copies.
    const zeus = createFakeClient('Zeus', 'east-wing-redraw', 13977, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    zeus.sentPackets.length = 0;
    EntityHandler.reconcileDrawnHostilesForScope(scope, [zeus as never]);
    assert.equal(zeus.sentPackets.length, 0, 'the redraw must stay off while the client spawns the hostiles');
}

function testEntryDoesNotPushCarriedQuestProgress(): void {
    const leader = createFakeClient('Zeus', 'east-wing-carried', 14011, 1);
    const joiner = createFakeClient('Telahair', 'east-wing-carried', 14012, 1);
    // Whatever each was showing in their own town.
    (leader.character as any).questTrackerState = 75;
    (joiner.character as any).questTrackerState = 50;

    attachPlayer(leader);
    attachPlayer(joiner);
    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);

    MissionHandler.syncMissionStateToClient(leader as never);
    MissionHandler.syncMissionStateToClient(joiner as never);

    const lastPercent = (client: FakeClient): number => {
        const packets = client.sentPackets.filter((packet) => packet.id === 0xB7);
        assert.ok(packets.length > 0, 'entry should send a quest progress packet');
        return new BitReader(packets[packets.length - 1].payload).readMethod4();
    };

    assert.equal(lastPercent(leader), 0, 'entry must not push the value carried in from a town');
    assert.equal(lastPercent(joiner), 0, 'entry must not push the value carried in from a town');
    assert.equal(
        Number((leader.character as any).questTrackerState),
        Number((joiner.character as any).questTrackerState),
        'both members of one run must open on the same tracker value'
    );

    GlobalState.sessionsByToken.delete(leader.token);
    GlobalState.sessionsByToken.delete(joiner.token);
}

function testInitialCanonicalSendsNoVisibleServerHostiles(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-initial', 13933, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    assertAllCanonicalHostiles(scope);

    // The server seeds the canonical roster but does NOT draw it: the client spawns these
    // hostiles from the level's own cues, and the server binds to those copies.
    //
    // Drawing them here would mean suppressing the cues, and the client's dungeon progress
    // cannot survive that -- Room.var_802 is accumulated only inside Room.SpawnCue, so held
    // cues leave every room reading as fully cleared. See the comment on
    // FIRST_SIGHT_SERVER_AUTHORITY_HOSTILE_LEVELS.
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x0F),
        false,
        'initial sync must not draw server hostiles; the client spawns them from its own cues'
    );
}

// A kill must reach the other member as DAMAGE, addressed with that member's own id.
//
// The client drops 0x07 and 0x0D for any entity with no class_122 record, and a hostile it
// spawned from its own level cue never has one -- which is why a server-decided death never
// left the killer's screen. 0x78 has no such gate: its reader calls TakeDamage, so the other
// client kills its own copy and runs its own death path, including the room bookkeeping its
// dungeon percentage is computed from.
async function testKillReachesTheOtherMemberAsLethalDamage(): Promise<void> {
    const zeus = createFakeClient('Zeus', 'east-wing-share', 14101, 1);
    const telahair = createFakeClient('Telahair', 'east-wing-share', 14102, 1);
    setParty(zeus, telahair);
    for (const client of [zeus, telahair]) {
        attachPlayer(client);
        GlobalState.sessionsByToken.set(client.token, client as never);
        EntityHandler.sendInitialLevelEntities(client as never, client.currentLevel);
    }
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    // Each client reports its own copy of the same authored hostile.
    attachProxy(zeus, 510001, 1);
    attachProxy(telahair, 610001, 1);
    const canonicalId = EntityHandler.resolveEntityAlias(zeus as never, 510001);
    assert.ok(canonicalId > 0, 'starter copy should bind to a canonical hostile');
    assert.equal(
        EntityHandler.resolveEntityAlias(telahair as never, 610001),
        canonicalId,
        'both copies of one authored hostile must bind to the same canonical'
    );

    const canonical = GlobalState.levelEntities.get(scope)?.get(canonicalId);
    assert.ok(canonical, 'canonical hostile should exist');
    assert.equal(Boolean(canonical.dead), false, 'the test hostile must start alive');

    // The server tracks the canonical, so by the time a death is broadcast it already
    // believes the other member copy is at zero -- and finalizeHostileDeath only sends an HP
    // correction when it thinks there is health left. Reproduce that, so this can only pass
    // if the destroy broadcast sends its own unconditional lethal damage.
    const telahairCopy = telahair.entities.get(610001);
    if (telahairCopy) { telahairCopy.hp = 0; }

    telahair.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(
        zeus as never,
        buildPowerHitPayload(510001, zeus.clientEntID, Math.round(Number(canonical.hp ?? 0)) + 999)
    );
    assert.equal(canonical.dead, true, 'the hit should kill the canonical hostile');

    const lethal = telahair.sentPackets
        .filter((packet) => packet.id === 0x78)
        .map((packet) => parseHpDelta(packet.payload))
        .filter((hp) => hp.entityId === 610001 && hp.delta < 0);
    assert.ok(lethal.length > 0, 'the other member must be sent damage against their OWN copy id');
    assert.ok(
        Math.abs(lethal[lethal.length - 1].delta) >= Math.round(Number(canonical.maxHp ?? 1)),
        'the damage must be lethal, or the copy survives on the other screen'
    );

    for (const client of [zeus, telahair]) {
        GlobalState.sessionsByToken.delete(client.token);
    }
}

async function testProxyAttachKillProgressAndLateJoiner(): Promise<void> {
    const zeus = createFakeClient('Zeus', 'east-wing-starter', 13933, 1);
    const telahair = createFakeClient('Telahair', 'east-wing-joiner', 63188, 1);
    setParty(zeus, telahair);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const starterScope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    zeus.sentPackets.length = 0;
    attachProxy(zeus, 500001, 0);
    assert.equal(EntityHandler.resolveEntityAlias(zeus as never, 500001), 920001, 'starter local proxy should map to canonical GreaterDemonMaligner');
    assert.equal(GlobalState.levelEntities.get(starterScope)?.has(500001), false, 'local proxy must not enter canonical level map');
    const canonical = GlobalState.levelEntities.get(starterScope)?.get(920001);
    assert.ok(canonical, 'canonical GreaterDemonMaligner should exist after proxy attach');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 500001 && parseHpDelta(packet.payload).delta > 0),
        true,
        'proxy attach should receive initial level-50 HP sync'
    );

    await CombatHandler.handlePowerHit(
        zeus as never,
        buildPowerHitPayload(500001, zeus.clientEntID, Math.round(Number(canonical.hp ?? 0)) + 999)
    );
    assert.equal(canonical.dead, true, 'starter should kill canonical GreaterDemonMaligner');

    const totals = getSharedDungeonProgressTotals(starterScope);
    const progressState = recomputeSharedDungeonProgress(starterScope);
    assert.deepEqual(totals, { total: EAST_WING_ENEMY_COUNT, defeated: 1 }, 'required-for-clear totals should count server canonical enemies');
    assert.equal(progressState?.progress, Math.floor((1 / EAST_WING_ENEMY_COUNT) * 100), 'East Wing progress should be floor(deadRequired / totalRequired * 100)');

    attachPlayer(telahair);
    GlobalState.sessionsByToken.set(telahair.token, telahair as never);
    EntityHandler.sendInitialLevelEntities(telahair as never, telahair.currentLevel);
    assert.equal(telahair.levelInstanceId, zeus.levelInstanceId, 'party joiner should adopt starter East Wing instance id');

    telahair.sentPackets.length = 0;
    attachProxy(telahair, 600001, 0);
    assert.equal(EntityHandler.resolveEntityAlias(telahair as never, 600001), 920001, 'late joiner proxy should map to the dead canonical id');
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 600001),
        true,
        'late joiner dead proxy should be destroyed instead of respawning alive'
    );
}

function resetRuntime(): void {
    GlobalState.levelEntities.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.levelQuestProgress.clear();
    GlobalState.combatContributions.clear();
    GlobalState.entityLifeNonces.clear();
    GlobalState.entityLastRewardNonces.clear();
    GlobalState.partyByMember.clear();
    GlobalState.partyGroups.clear();
}

async function main(): Promise<void> {
    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelQuestProgress = new Map(GlobalState.levelQuestProgress);
    const combatContributions = new Map(GlobalState.combatContributions);
    const entityLifeNonces = new Map(GlobalState.entityLifeNonces);
    const entityLastRewardNonces = new Map(GlobalState.entityLastRewardNonces);
    const partyByMember = new Map(GlobalState.partyByMember);
    const partyGroups = new Map(GlobalState.partyGroups);

    ensureDataLoaded();
    try {
        resetRuntime();
        testRegistryLoad();

        resetRuntime();
        testInitialCanonicalSendsNoVisibleServerHostiles();
    testMissingDrawnHostilesAreRedrawn();
    testStaleTrackedHostilesDoNotInflateProgress();
    testEntryDoesNotPushCarriedQuestProgress();

        resetRuntime();
        await testProxyAttachKillProgressAndLateJoiner();
    await testKillReachesTheOtherMemberAsLethalDamage();

        console.log('east_wing_dungeon_spawns_regression: ok');
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelQuestProgress = levelQuestProgress;
        GlobalState.combatContributions = combatContributions;
        GlobalState.entityLifeNonces = entityLifeNonces;
        GlobalState.entityLastRewardNonces = entityLastRewardNonces;
        GlobalState.partyByMember = partyByMember;
        GlobalState.partyGroups = partyGroups;
    }
}

void main().catch((error) => {
    console.error('east_wing_dungeon_spawns_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
