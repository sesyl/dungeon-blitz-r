import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { MissionHandler } from '../handlers/MissionHandler';
import { NpcHandler } from '../handlers/NpcHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { patchMissionTypes } from '../scripts/patch_gameswz_clear_bandits_mission';
import { parseSwz } from '../scripts/swzPatchUtils';
import { WorldEnter } from '../utils/WorldEnter';

const MISSION_NOT_STARTED = 0;
const MISSION_IN_PROGRESS = 1;
const MISSION_READY_TO_TURN_IN = 2;
const MISSION_CLAIMED = 3;

type FakeClient = {
    userId: number;
    clientEntID: number;
    currentLevel: string;
    character: any;
    characters: any[];
    sentPackets: Array<{ id: number; payload: Buffer }>;
    saveReasons: string[];
    send(id: number, payload: Buffer): void;
    sendBitBuffer(id: number, bb: BitBuffer): void;
    scheduleCharacterSave(reason: string): void;
};

function ensureDataLoaded(): void {
    if (!MissionLoader.getMissionDef(MissionID.ClearTheBandits)) {
        const dataDir = path.resolve(__dirname, '../data');
        MissionLoader.load(dataDir);
        LevelConfig.load(dataDir);
    }
}

function createCharacter(wardenState: number, banditState: number = MISSION_NOT_STARTED): any {
    const missions: Record<string, any> = {
        [String(MissionID.DeliverToSwamp)]: { state: MISSION_CLAIMED },
        [String(MissionID.SeeTheWarden)]: { state: wardenState }
    };
    if (banditState !== MISSION_NOT_STARTED) {
        missions[String(MissionID.ClearTheBandits)] = { state: banditState, currCount: 0 };
    }

    return {
        name: 'BanditTester',
        level: 11,
        CurrentLevel: { name: 'BridgeTown', x: 10325, y: 499 },
        missions
    };
}

function createClient(): FakeClient {
    const character = createCharacter(MISSION_CLAIMED, MISSION_IN_PROGRESS);
    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    const saveReasons: string[] = [];
    return {
        userId: 11,
        clientEntID: 7654321,
        currentLevel: 'BridgeTown',
        character,
        characters: [character],
        sentPackets,
        saveReasons,
        send(id: number, payload: Buffer): void {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        },
        scheduleCharacterSave(reason: string): void {
            saveReasons.push(reason);
        }
    };
}

function testMissionDefinitionAndPrerequisite(): void {
    ensureDataLoaded();
    const mission = MissionLoader.getMissionDef(MissionID.ClearTheBandits);
    assert.ok(mission, 'Clear the Bandits mission definition was not loaded');
    assert.equal(mission.DisplayName, 'Clear the Bandits');
    assert.deepEqual(mission.PreReqMissions, ['SeeTheWarden']);
    assert.equal(mission.ContactName, 'Felguard');
    assert.equal(mission.ReturnName, 'Felguard');
    assert.equal(mission.CompleteCount, 20);
    assert.equal(mission.ExpRewardValue, 300);
    assert.equal(mission.GoldRewardValue, 500);
    assert.equal(
        mission.OfferText,
        'Hey! Are you the slayer of Aracnaea?=@Yes, I am.=Hero please help me! I am really tired of the bandit problem. Could you kill some of them for me?=@Okey I will do my best for our people.'
    );
    assert.equal(
        mission.ActiveText,
        mission.OfferText,
        'active dialogue must replay the complete offer story'
    );
    assert.equal(
        mission.ReturnText,
        'Thank you hero. Please accept this little gift. Maybe this could help for your adventure.=@My pleasures. I will help all of you as much as I can. Good luck for guarding the bridge!=Good luck to you, too. May your path be clear, great hero.'
    );
    assert.equal(mission.PraiseText, mission.ReturnText, 'claimed dialogue must replay the complete return story');

    const beforeWardenTurnIn = (NpcHandler as any).findBestMission(
        createCharacter(MISSION_READY_TO_TURN_IN),
        'felguard'
    );
    assert.equal(beforeWardenTurnIn, null, 'mission was offered before SeeTheWarden was claimed');

    const afterWardenTurnIn = (NpcHandler as any).findBestMission(
        createCharacter(MISSION_CLAIMED),
        'felguard'
    );
    assert.equal(afterWardenTurnIn?.missionId, MissionID.ClearTheBandits);
    assert.equal(afterWardenTurnIn?.dialogueId, 2, 'Felguard did not offer the new mission');
}

function testReservedSlotSaveMigration(): void {
    const deletedSlotCharacter = createCharacter(MISSION_CLAIMED, MISSION_CLAIMED);
    const deletedSlotRepair = MissionHandler.repairEarlyStoryOnLogin(deletedSlotCharacter, 'BridgeTown');
    assert.equal(deletedSlotRepair.didMutate, true);
    assert.equal(
        deletedSlotCharacter.missions[String(MissionID.ClearTheBandits)],
        undefined,
        'legacy DELETED1 completion incorrectly claimed the new quest'
    );

    const legacyMissionCharacter = createCharacter(MISSION_CLAIMED);
    legacyMissionCharacter.missions['294'] = { state: MISSION_IN_PROGRESS, currCount: 7 };
    MissionHandler.repairEarlyStoryOnLogin(legacyMissionCharacter, 'BridgeTown');
    assert.equal(legacyMissionCharacter.missions['294'], undefined);
    assert.deepEqual(
        legacyMissionCharacter.missions[String(MissionID.ClearTheBandits)],
        { state: MISSION_IN_PROGRESS, currCount: 7 },
        'temporary mission 294 progress was not migrated into reserved slot 11'
    );

    const unsafeMissionCharacter = createCharacter(MISSION_CLAIMED);
    unsafeMissionCharacter.missions['293'] = { state: MISSION_IN_PROGRESS, currCount: 4 };
    unsafeMissionCharacter.clearTheBanditsStableSlotMigrated = true;
    MissionHandler.repairEarlyStoryOnLogin(unsafeMissionCharacter, 'BridgeTown');
    assert.equal(unsafeMissionCharacter.missions['293'], undefined);
    assert.deepEqual(
        unsafeMissionCharacter.missions[String(MissionID.ClearTheBandits)],
        { state: MISSION_IN_PROGRESS, currCount: 4 },
        'temporary reserved-slot progress was not migrated into the stable client mission slot'
    );

    const invisibleStartCharacter = createCharacter(MISSION_CLAIMED, MISSION_IN_PROGRESS);
    invisibleStartCharacter.clearTheBanditsServerPresentationMigrated = true;
    MissionHandler.repairEarlyStoryOnLogin(invisibleStartCharacter, 'BridgeTown');
    assert.equal(
        invisibleStartCharacter.missions[String(MissionID.ClearTheBandits)],
        undefined,
        'invisible zero-progress mission start was not reset for the repaired client presentation'
    );
    assert.equal(invisibleStartCharacter.clearTheBanditsPresentationResetV3, true);
}

function testMissionExistsInLooseAndEmbeddedClientData(): void {
    const loosePath = path.resolve(__dirname, '../../client/content/xml/MissionTypes.xml');
    const looseXml = fs.readFileSync(loosePath, 'utf8');
    assert.equal(patchMissionTypes(looseXml).changed, false, 'loose client MissionTypes is not patched');

    const swzPath = path.resolve(__dirname, '../../client/content/localhost/p/cbq/Game.swz');
    const swz = parseSwz(swzPath);
    const missionChunk = swz.chunks.find((chunk) => /<MissionTypes[>\s]/.test(chunk.xml));
    assert.ok(missionChunk, 'Game.swz has no MissionTypes chunk');
    assert.equal(
        patchMissionTypes(missionChunk.xml).changed,
        false,
        'served Game.swz does not contain the restored original mission data'
    );
}

function testClientPacketHidesOnlyUnsafeMissionSlot(): void {
    const character = createCharacter(MISSION_CLAIMED, MISSION_IN_PROGRESS);
    character.missions[String(MissionID.ClearTheBandits)].currCount = 9;
    character.missions[String(MissionID.ACTales6Embassy)] = { state: MISSION_CLAIMED };

    const serialized = (WorldEnter as any).buildSerializableMissionsState(character);
    assert.equal(serialized[String(MissionID.ClearTheBandits)], undefined);
    assert.deepEqual(
        serialized[String(MissionID.ACTales6Embassy)],
        { state: MISSION_CLAIMED },
        'hiding the unsafe server-only slot altered an unrelated client mission'
    );
    assert.equal(
        character.missions[String(MissionID.ClearTheBandits)].currCount,
        9,
        'hiding the client slot destroyed server-side kill progress'
    );
}

function testDialogueAdvancesOneBubblePerClickAndLoops(): void {
    const client = createClient();
    const dialogue = (NpcHandler as any).sendClearTheBanditsDialogue.bind(NpcHandler);

    dialogue(client, 3272992, 2);
    dialogue(client, 3272992, 3);
    dialogue(client, 3272992, 3);
    dialogue(client, 3272992, 3);
    dialogue(client, 3272992, 3);

    const bubbles = client.sentPackets
        .filter((packet) => packet.id === 0x76)
        .map((packet) => {
            const reader = new BitReader(packet.payload);
            return { entityId: reader.readMethod4(), text: reader.readMethod13() };
        });
    assert.deepEqual(bubbles, [
        { entityId: 3272992, text: 'Hey! Are you the slayer of Aracnaea?' },
        { entityId: client.clientEntID, text: 'Yes, I am.' },
        {
            entityId: 3272992,
            text: 'Hero please help me! I am really tired of the bandit problem. Could you kill some of them for me?'
        },
        { entityId: client.clientEntID, text: 'Okey I will do my best for our people.' },
        { entityId: 3272992, text: 'Hey! Are you the slayer of Aracnaea?' }
    ]);
}

async function testOnlyHumanBanditsCount(): Promise<void> {
    ensureDataLoaded();
    const humanBandits = [
        'BanditRogue',
        'BanditRogue2',
        'BanditGreatWarrior',
        'BanditGreatWizard',
        'BanditGreatRogue',
        'BanditTwinA',
        'BanditTwinB',
        'BanditBoss',
        'BanditRogueHard',
        'BanditRogue2Hard',
        'BanditGreatWarriorHard',
        'BanditGreatWizardHard',
        'BanditGreatRogueHard',
        'BanditTwinAHard',
        'BanditTwinBHard',
        'BanditBossHard'
    ];

    for (const enemyName of humanBandits) {
        const client = createClient();
        await MissionHandler.handleEnemyDefeatMissionProgress(client as never, { EntName: enemyName });
        assert.equal(
            client.character.missions[String(MissionID.ClearTheBandits)].currCount,
            1,
            `${enemyName} did not count as a human bandit`
        );
    }

    for (const enemyName of [
        'BanditImp',
        'BanditSpider',
        'BanditGreatSpider',
        'BanditImpHard',
        'BanditSpiderHard',
        'BanditGreatSpiderHard',
        'RisenBandit'
    ]) {
        const client = createClient();
        await MissionHandler.handleEnemyDefeatMissionProgress(client as never, { EntName: enemyName });
        assert.equal(
            client.character.missions[String(MissionID.ClearTheBandits)].currCount,
            0,
            `${enemyName} incorrectly counted as a normal Felbridge human bandit`
        );
    }

    const dungeonClient = createClient();
    dungeonClient.currentLevel = 'BT_Mission2';
    dungeonClient.character.CurrentLevel.name = 'BT_Mission2';
    await MissionHandler.handleEnemyDefeatMissionProgress(
        dungeonClient as never,
        { EntName: 'BanditRogueHard' }
    );
    assert.equal(
        dungeonClient.character.missions[String(MissionID.ClearTheBandits)].currCount,
        1,
        'human bandits killed inside the Felbridge dungeon did not advance the mission'
    );
}

async function testTwentiethKillCompletesMission(): Promise<void> {
    const client = createClient();
    client.character.missions[String(MissionID.ClearTheBandits)].currCount = 19;
    await MissionHandler.handleEnemyDefeatMissionProgress(client as never, { EntName: 'BanditRogue' });

    const entry = client.character.missions[String(MissionID.ClearTheBandits)];
    assert.equal(entry.currCount, 20);
    assert.equal(entry.state, MISSION_READY_TO_TURN_IN);
    assert.equal(client.sentPackets.filter((packet) => packet.id === 0x83).length, 1);
    assert.equal(client.sentPackets.filter((packet) => packet.id === 0x86).length, 1);
    assert.equal(client.sentPackets.filter((packet) => packet.id === 0x44).length, 0);
    const progress = client.sentPackets.find((packet) => packet.id === 0x83);
    const complete = client.sentPackets.find((packet) => packet.id === 0x86);
    assert.ok(progress && complete);
    assert.equal(new BitReader(progress.payload).readMethod4(), MissionID.ClearTheBandits);
    assert.equal(new BitReader(complete.payload).readMethod4(), MissionID.ClearTheBandits);
    assert.deepEqual(client.saveReasons, ['enemy kill mission progress']);
}

function testTrackerStateResyncsWithoutUsingPlayerDataSlot(): void {
    const client = createClient();
    client.character.missions[String(MissionID.ClearTheBandits)].currCount = 8;
    MissionHandler.syncMissionStateToClient(client as never);

    const added = client.sentPackets.find((packet) => packet.id === 0x85);
    const progress = client.sentPackets.find((packet) => packet.id === 0x83);
    assert.ok(added && progress, 'active tracker state was not restored after login');
    assert.equal(new BitReader(added.payload).readMethod4(), MissionID.ClearTheBandits);
    const progressReader = new BitReader(progress.payload);
    assert.equal(progressReader.readMethod4(), MissionID.ClearTheBandits);
    assert.equal(progressReader.readMethod4(), 8);

    const claimedClient = createClient();
    claimedClient.character.missions[String(MissionID.ClearTheBandits)] = { state: MISSION_CLAIMED, currCount: 20 };
    MissionHandler.syncMissionStateToClient(claimedClient as never);
    const claimed = claimedClient.sentPackets.find((packet) => packet.id === 0x84);
    assert.ok(claimed, 'claimed quest state was not restored to suppress the offer marker');
    const claimedReader = new BitReader(claimed.payload);
    assert.equal(claimedReader.readMethod4(), MissionID.ClearTheBandits);
    assert.equal(claimedReader.readBit(), 0);
}

Promise.resolve()
    .then(testMissionDefinitionAndPrerequisite)
    .then(testReservedSlotSaveMigration)
    .then(testMissionExistsInLooseAndEmbeddedClientData)
    .then(testClientPacketHidesOnlyUnsafeMissionSlot)
    .then(testDialogueAdvancesOneBubblePerClickAndLoops)
    .then(testOnlyHumanBanditsCount)
    .then(testTwentiethKillCompletesMission)
    .then(testTrackerStateResyncsWithoutUsingPlayerDataSlot)
    .then(() => {
        console.log('Clear the Bandits mission regression tests passed.');
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
