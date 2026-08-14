import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  Instruction,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  writeSwf,
} from "./swfPatchUtils";

// The client drops PKTTYPE_ENT_DESTROY for any entity that has no brain
// component, so the server can never remove such an entity from the screen.
//
// LinkUpdater.method_1018 (the 0x0D reader) is:
//
//   var e:Entity = game.GetEntFromID(packet.readID());
//   if (Boolean(e) && Boolean(e.var_38)) {
//       e.var_38.var_2778 = true;   // deferred-removal flag
//   }
//
// and Game's per-entity tick only *reads* that flag through method_1366, which
// it calls only when `var_38` is set — entities without one take method_1770
// instead, which never consults it. So the two halves of the removal path agree:
// no brain, no removal. Such an entity then stands wherever it was created,
// motionless (nothing drives it) and holding every buff FX it was ever given
// (nothing ticks them down), until the level itself is torn down — which is why
// the second Tag Ugo in Dread Goblin Hideout only disappears when the rank plate
// arrives.
//
// ============================================================================
// DO NOT APPLY. The bytecode below is correct and does not crash -- it was
// applied and playtested on 2026-08-14 -- but it is the wrong lever. Read this
// before touching this file again.
// ============================================================================
//
// `var_38` is NOT an AI brain. It is `class_122(game, entity)`, the server-driven
// remote-entity record: var_914/var_950 are the server's target physPosX/physPosY,
// var_1794 its velocity, var_2778 the deferred-destroy flag. An entity only has one
// if the *server* created it on that client through 0x0F. An entity the client
// spawned itself from a level cue -- which is every hostile in a CLIENT_SPAWN level
// like JC_Mini2 -- has none, and so has no server channel at all.
//
// That is why the whole family of server-side fixes bounced off it. The 0x07
// incremental reader, LinkUpdater.method_1072, opens with
//
//     if (!ent || !ent.var_38) return;
//
// so the dead-state packet is discarded at the door -- and it is the packet that
// would otherwise do the right thing, because further down it holds exactly the
// retirement the engine wants:
//
//     if (ent.entState == Entity.const_6 && !wasAlreadyDead) {
//         ent.gfx.m_Seq.method_428();            // the death animation
//         ent.var_217 = game.mTimeThisTick;      // the corpse stamp
//     }
//
// Two things went wrong when this patch shipped:
//
//   * No death animation. Setting the tombstone skips method_428 and the corpse
//     delay entirely; the body is spliced on the next tick.
//   * Enemies vanished that had never been hit. 0x0D was a silent no-op for these
//     entities, which masked every routine destroy the server already sends --
//     relevance culling above all. Honouring it made all of them lethal. Any patch
//     that makes 0x0D effective here must be paired with a server audit of the ~20
//     destroy send sites in EntityHandler/CombatHandler.
//
// The two designs actually worth pursuing, in order of preference:
//
//   1. Make the server own these hostiles for real, so they arrive by 0x0F and get a
//      class_122. Then 0x07, 0x0D, the death animation and the corpse timing all work
//      with no client patch. This was attempted once and reverted because suppressing
//      the client's own level cues only caught ~16 of 34.
//   2. Patch method_1072's early return to admit brainless entities, guarding the
//      three `ent.var_38.x += ...` writes that follow. This restores the animation and
//      the timing and needs no 0x0D change at all -- but it does not fit the in-place
//      byte budget, so it needs a length-changing patch and a code_length fixup that
//      swfPatchUtils does not do today.
//
// What follows is the tombstone design, kept because it is a fully verified example
// of the one safe way to retire a brainless entity, should that ever be wanted again.
//
// THE MECHANISM: set the engine's own retire-me tombstone, `Entity.var_1835`, and
// call nothing at all.
//
// Game.method_1970 ticks brainless entities under `if (!entity.var_38)` -- exactly
// this set -- and retires them itself:
//
//     if (!entity.method_1770()) { entity.DestroyEntity(true); entities.splice(i, 1); }
//
// method_1770 was fully deobfuscated on 2026-08-14 (see build/deob.js; the prologue
// yields local7=false/local8=true, which folds 142 of its 179 branches away). Its
// head is:
//
//     local1 = this.velocity.x;
//     local2 = uint(this.var_1.mTimeThisTick);
//     if (this.var_1835) return false;                 // <- the tombstone
//     if (this.entState == const_6 && !this.var_24 && !this.behaviorType.var_995
//      && local2 - this.var_217 >= TIME_MONSTER_LAYS_DEAD_BEFORE_VANISHING)
//         return false;
//     ... normal tick, which reads var_818 and var_195 with NO null check ...
//
// So one property write makes the engine remove the body on its next tick -- destroy
// AND splice, in the order it expects. Nothing is torn down here, so nothing this
// branch touches can be null, and a property write cannot throw.
//
// Two earlier designs are recorded here because both shipped and both were wrong.
//
// 1. Calling Entity.DestroyEntity, in either argument form (2026-08-13):
//
//      DestroyEntity(true)  -> crash on dungeon entry. `true` reaches the branch
//                              that calls linkUpdater.method_1397(this) -- the
//                              client announcing the destroy back to the server --
//                              for an entity the client never owned.
//      DestroyEntity(false) -> crash on dungeon entry, with this stack:
//                                Error #1009 at Entity/method_1770()
//                                             at Game/method_1970()
//
//    DestroyEntity nulls 20 fields including var_818 and var_195, and -- this is the
//    part that makes it unusable -- it sets the tombstone on `this.var_183.var_1835`,
//    the entity's *ghost*, never on `this`. So the corpse stays in Game.entities with
//    var_1835 still false, sails past the guard above on the next tick, and dies
//    dereferencing the fields DestroyEntity just emptied.
//
// 2. `ent.var_217 = 0`, to pretend the corpse timer had elapsed (2026-08-14). This
//    stopped the crash but did not remove anything: that return is gated on all four
//    of entState == const_6, !var_24, !behaviorType.var_995 and the timer, and the
//    server's 0x07 dead-state packet only supplies the stamp. var_1835 is the one
//    condition that stands alone.
//
// The rewrite fits inside the original 38-byte tail, so no branch outside the
// replaced region moves and the method body keeps its length.

const DEFAULT_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "DungeonBlitz.swf",
);

// Editing index.html's own `clientrev=` literal does nothing: StaticServer
// 302-redirects every SWF request to its own `clientRevision` token, so that
// constant is the only cache key a browser ever sees. Report the SWF's hash and
// let the operator bump StaticServer.clientRevision, or players keep running the
// cached previous build and this patch looks like it did nothing.
function reportCacheKey(swfPath: string): void {
  if (!fs.existsSync(swfPath)) {
    return;
  }
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  console.log(
    `  DungeonBlitz.swf is now swf-${digest}. ` +
    "Bump StaticServer.clientRevision so browsers stop serving the cached client.",
  );
}

// Entity's retire-me tombstone: one read site (the head of method_1770) and, before
// this patch, one write site (DestroyEntity, on the ghost).
const TOMBSTONE = "var_1835";

// Opcodes used below.
const OP_NOP = 0x02;
const OP_PUSHBYTE = 0x24;
const OP_PUSHTRUE = 0x26;
const OP_PUSHFALSE = 0x27;
const OP_GETLOCAL = 0x62;
const OP_GETPROPERTY = 0x66;
const OP_SETPROPERTY = 0x61;
const OP_IFFALSE = 0x12;
const OP_RETURNVOID = 0x47;
const OP_CALLPROPVOID = 0x4f;
const OP_FINDPROPSTRICT = 0x5d;
const OP_CALLPROPERTY = 0x46;
const OP_DUP = 0x2a;
const OP_CONVERT_B = 0x76;
const OP_POP = 0x29;

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npx ts-node src/server/scripts/patch-dungeonblitz-destroy-entity-without-brain.ts [--verify] [--swf <path>]",
        "",
        "Makes the client honour PKTTYPE_ENT_DESTROY for entities that have no brain",
        "component. Without it such an entity can never be removed by the server and",
        "stands motionless in the level until the level is torn down.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function s24(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
}

function u30(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

type Context = {
  ctx: ReturnType<typeof parseSwf>;
  abc: ReturnType<typeof parseAbc>;
  methodBody: NonNullable<ReturnType<ReturnType<typeof parseAbc>["methodBodies"]["get"]>>;
  code: Buffer;
  instructions: Instruction[];
};

function loadMethod1018(swfPath: string): Context {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "LinkUpdater");
  if (classIndex === null) {
    throw new PatchError("Could not find LinkUpdater class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1018");
  if (methodIdx === null) {
    throw new PatchError("Could not find LinkUpdater.method_1018 (the PKTTYPE_ENT_DESTROY reader).");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find a method body for LinkUpdater.method_1018 (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  return { ctx, abc, methodBody, code, instructions: disassemble(code, "LinkUpdater.method_1018") };
}

const KIND_QNAME = 0x07;

// `var_1835` is declared `internal` on Entity and LinkUpdater never touches it, so
// the index has to be borrowed from Entity's own code. That is safe here and only
// here: the borrowed multiname is required to be a QName, which names one absolute
// namespace and therefore resolves the same from any class. A Multiname or
// MultinameL resolves through a namespace *set* belonging to the class it was
// written for, and borrowing one of those is the trap swfPatchUtils warns about.
function borrowedPropertyMultiname(context: Context, className: string, name: string, opcodes: number[]): number {
  const index = multinameIndex(context, className, name, opcodes);
  const kind = context.abc.multinameKinds[index];
  if (kind !== KIND_QNAME) {
    throw new PatchError(
      `"${name}" resolves to multiname ${index} of kind 0x${kind.toString(16)}, not a QName; ` +
      "it cannot be borrowed from another class. Refusing to patch.",
    );
  }
  return index;
}

function multinameIndex(context: Context, className: string, name: string, opcodes: number[]): number {
  const classIndex = classIndexByName(context.abc, className);
  if (classIndex === null) {
    throw new PatchError(`Could not find ${className} class.`);
  }

  const methodIdxs = new Set<number>();
  for (const trait of context.abc.instances[classIndex].traits) {
    if (trait.methodIdx !== null) {
      methodIdxs.add(trait.methodIdx);
    }
  }

  for (const methodIdx of methodIdxs) {
    const body = context.abc.methodBodies.get(methodIdx);
    if (!body) {
      continue;
    }
    const code = context.ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    let instructions: Instruction[];
    try {
      instructions = disassemble(code, `${className}.method#${methodIdx}`);
    } catch {
      continue;
    }
    for (const instruction of instructions) {
      if (!opcodes.includes(instruction.opcode) || instruction.operands.length === 0) {
        continue;
      }
      const index = instruction.operands[0][1];
      if (context.abc.multinameNames[index] === name) {
        return index;
      }
    }
  }

  throw new PatchError(`Could not resolve a ${className}-scoped multiname for "${name}".`);
}

// The exact original tail, so a changed client is refused rather than corrupted.
function findOriginalTail(context: Context): { start: number; end: number; var38: number; flag: number } {
  const { instructions, abc } = context;
  for (let i = 0; i + 16 < instructions.length; i += 1) {
    const window = instructions.slice(i, i + 17);
    const opcodes = window.map((instruction) => instruction.opcode);
    const expected = [
      OP_FINDPROPSTRICT, OP_GETLOCAL, OP_CALLPROPERTY, OP_DUP, OP_CONVERT_B, OP_IFFALSE, OP_POP,
      OP_FINDPROPSTRICT, OP_GETLOCAL, OP_GETPROPERTY, OP_CALLPROPERTY, OP_IFFALSE,
      OP_GETLOCAL, OP_GETPROPERTY, OP_PUSHTRUE, OP_SETPROPERTY, OP_RETURNVOID,
    ];
    if (opcodes.join(",") !== expected.join(",")) {
      continue;
    }

    const var38 = window[9].operands[0][1];
    const flag = window[15].operands[0][1];
    if (abc.multinameNames[var38] !== abc.multinameNames[window[13].operands[0][1]]) {
      continue;
    }
    const last = window[16];
    return { start: window[0].offset, end: last.offset + last.size, var38, flag };
  }

  throw new PatchError(
    "LinkUpdater.method_1018 does not have the expected destroy tail; refusing to patch an unknown client.",
  );
}

// The patched branch calls nothing, so the marker is the tombstone write itself.
// Looking for a DestroyEntity call here -- as this did while that was the design --
// reports an already-patched client as unpatched and rewrites the tail a second
// time, over a body that no longer holds the original 17-instruction sequence.
function alreadyPatched(context: Context): boolean {
  return context.instructions.some(
    (instruction) =>
      instruction.opcode === OP_SETPROPERTY &&
      instruction.operands.length > 0 &&
      context.abc.multinameNames[instruction.operands[0][1]] === TOMBSTONE,
  );
}

function buildTail(tail: { start: number; end: number; var38: number; flag: number }, tombstone: number): Buffer {
  const var38 = u30(tail.var38);
  const flag = u30(tail.flag);
  const retire = u30(tombstone);

  // Offsets are computed from the region start so the two branches land exactly
  // on the alternative path and on the method's original returnvoid.
  const noBrain =
    2 + // getlocal 4
    4 + // iffalse -> return
    2 + // getlocal 4
    (1 + var38.length) + // getproperty var_38
    4 + // iffalse -> noBrain
    2 + // getlocal 4
    (1 + var38.length) + // getproperty var_38
    1 + // pushtrue
    (1 + flag.length) + // setproperty var_2778
    1; // returnvoid

  const afterCall = noBrain + 2 + 1 + (1 + retire.length);
  const total = tail.end - tail.start;
  const returnOffset = total - 1;
  if (afterCall > returnOffset) {
    throw new PatchError("Rewritten destroy tail does not fit in the original method body.");
  }

  const bytes: number[] = [
    OP_GETLOCAL, 4,
    OP_IFFALSE, ...s24(returnOffset - 6),
    OP_GETLOCAL, 4,
    OP_GETPROPERTY, ...var38,
    OP_IFFALSE, ...s24(noBrain - (13 + var38.length)),
    OP_GETLOCAL, 4,
    OP_GETPROPERTY, ...var38,
    OP_PUSHTRUE,
    OP_SETPROPERTY, ...flag,
    OP_RETURNVOID,
    // `ent.var_1835 = true` -- one property write, and deliberately nothing else.
    //
    // This is the engine's own retire-me tombstone, and the first thing the brainless tick
    // Entity.method_1770 tests: `if (this.var_1835) return false`, reached before any field
    // DestroyEntity would have emptied. Game.method_1970 answers a false return with
    // `DestroyEntity(true); entities.splice(i, 1)` -- destroy AND splice, in the order the
    // engine expects -- and it only ticks entities with no brain, which is exactly this set.
    //
    // Calling anything from here is what crashed the client, twice; a property write cannot
    // throw, and nothing is torn down here, so this branch can no longer produce either
    // failure. The header explains why DestroyEntity is not a substitute: it stamps the
    // tombstone on the entity's ghost, `this.var_183`, and never on `this`.
    OP_GETLOCAL, 4,
    OP_PUSHTRUE,
    OP_SETPROPERTY, ...retire,
  ];

  while (bytes.length < returnOffset) {
    bytes.push(OP_NOP);
  }
  bytes.push(OP_RETURNVOID);

  if (bytes.length !== total) {
    throw new PatchError(`Rewritten destroy tail is ${bytes.length} bytes, expected ${total}.`);
  }
  return Buffer.from(bytes);
}

function patchSwf(swfPath: string, verify: boolean): void {
  const context = loadMethod1018(swfPath);

  if (alreadyPatched(context)) {
    console.log(`${swfPath}: already patched (LinkUpdater.method_1018 destroys brainless entities).`);
    reportCacheKey(swfPath);
    return;
  }
  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; brainless entities still ignore PKTTYPE_ENT_DESTROY.`);
  }

  const tail = findOriginalTail(context);
  const tombstone = borrowedPropertyMultiname(context, "Entity", TOMBSTONE, [OP_SETPROPERTY, OP_GETPROPERTY]);
  const data = buildTail(tail, tombstone);

  const patches: BytePatch[] = [
    {
      key: "LinkUpdater.method_1018.destroyTail",
      start: context.methodBody.codeStart + tail.start,
      end: context.methodBody.codeStart + tail.end,
      data,
      detail: "destroy brainless entities instead of dropping the packet",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(context.ctx.body, patches);
  writeSwf(context.ctx, body, delta);
  reportCacheKey(swfPath);
  console.log(
    `${swfPath}: patched LinkUpdater.method_1018 ` +
    `(${data.length} bytes rewritten in place, ${TOMBSTONE} multiname ${tombstone}).`,
  );
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
