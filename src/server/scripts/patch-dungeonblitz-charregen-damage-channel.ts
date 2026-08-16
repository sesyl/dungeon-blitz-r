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

// Make PKTTYPE_CHAR_REGEN carry damage, not only healing.
//
// THE PROBLEM. A hostile the client spawned from its own level cue -- every enemy in a
// CLIENT_SPAWN level like JC_Mini2 -- has no `var_38` (the class_122 server-driven record),
// and both LinkUpdater.method_1072 (0x07) and method_1018 (0x0D) return at the door without
// one. So a kill decided anywhere but on that client's own screen could never be delivered:
// the live East Wing logs showed the destroy going out addressed with each viewer's OWN local
// id, told=[both members], and the enemy still standing and swinging on the other screen.
//
// 0x78 looked like the way through, because its reader has no such gate:
//
//   LinkUpdater.method_1813(p):  e = var_1.GetEntFromID(p.method_4());
//                                if (e) method_3000(e, p.method_45(), false);
//   LinkUpdater.method_1549(p):  same, PKTTYPE_SERVER_ADJUST_HP, with `true`.
//
// It reaches these entities. It just refuses to hurt them. method_3000 is:
//
//   if (!ent || amount <= 0) return;                     <-- (A)
//   missing = ent.maxHP - ent.currHP;
//   if (missing <= 0) { ent.currHP = ent.maxHP; ... return; }   <-- (B)
//   if (amount > missing) amount = missing;
//   ent.TakeDamage(-amount, showFloater);
//
// The negate at the bottom is the whole story: a POSITIVE amount is the heal, and a negative
// one is dropped by (A) before it can mean anything. Every "send lethal 0x78" design is a
// no-op against that line, and so is every negative-delta HP correction the server already
// sends. (B) is the second trap: even once (A) admits damage, a target at full health takes
// the "already topped up" branch and never reaches TakeDamage -- which is exactly the state
// of an enemy the receiving player has not personally hit, i.e. every enemy the OTHER member
// killed.
//
// THE PATCH. Two edits, both in place, neither changing a single byte of length, so no branch
// outside the replaced region moves and the method body keeps its code_length:
//
//   (A) `lessequals` (0xae) -> `equals` (0xab). The gate becomes `amount == 0`, so only a
//       meaningless zero is refused and both signs flow on.
//   (B) `getlocal 4; pushbyte 0; ifnle L` (8 bytes) -> `nop nop nop nop; jump L` (8 bytes).
//       The full-health shortcut is bypassed; the `amount > missing` clamp below it still
//       protects the heal direction (a heal is clamped to the missing amount), and a negative
//       amount can never satisfy `amount > missing` for a non-negative `missing`, so damage
//       passes through unclamped as intended.
//
// WHAT THIS TURNS ON ELSEWHERE. Every negative-delta 0x78 the server sends stops being a
// silent no-op and becomes real damage on the receiving client. They were all written meaning
// exactly that -- "take back the health your copy wrongly has" -- but they were never once
// observed doing it, so treat the first playtest as the audit.
//
// Verified against the served SWF with FFDec P-code before and after; see
// `-format script:pcode -selectclass LinkUpdater`.

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

const OP_NOP = 0x02;
const OP_PUSHBYTE = 0x24;
const OP_GETLOCAL = 0x62;
const OP_GETLOCAL_2 = 0xd2;
const OP_IFNLE = 0x0d;
const OP_JUMP = 0x10;
const OP_LESSEQUALS = 0xae;
const OP_EQUALS = 0xab;

type Args = {
  swfPath: string;
  outputPath: string;
  verify: boolean;
};

function parseArgs(argv: string[]): Args {
  let swfPath = DEFAULT_SWF;
  let outputPath = "";
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--output" || arg === "-o") {
      outputPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch-dungeonblitz-charregen-damage-channel.ts [--verify] [--swf <path>] [--output <path>]",
        "",
        "Lets LinkUpdater.method_3000 apply negative PKTTYPE_CHAR_REGEN deltas as damage,",
        "so the server can kill an entity the client spawned itself.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, outputPath: outputPath || swfPath, verify };
}

function isPushByteZero(inst: Instruction | undefined): boolean {
  return Boolean(inst) && inst!.opcode === OP_PUSHBYTE && inst!.operands[0]?.[1] === 0;
}

function isGetLocal(inst: Instruction | undefined, register: number): boolean {
  return Boolean(inst) && inst!.opcode === OP_GETLOCAL && inst!.operands[0]?.[1] === register;
}

function analyzePatch(swfPath: string): { ctx: ReturnType<typeof parseSwf>; patches: BytePatch[] } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "LinkUpdater");
  if (classIndex === null) {
    throw new PatchError("LinkUpdater class not found");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_3000");
  if (methodIdx === null) {
    throw new PatchError("LinkUpdater.method_3000 not found");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError("LinkUpdater.method_3000 body not found");
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, "LinkUpdater.method_3000");
  const patches: BytePatch[] = [];

  // (A) the entry gate: getlocal2; pushbyte 0; lessequals
  const gateIndex = instructions.findIndex(
    (inst, index) =>
      inst.opcode === OP_LESSEQUALS &&
      isPushByteZero(instructions[index - 1]) &&
      instructions[index - 2]?.opcode === OP_GETLOCAL_2,
  );
  const gateAlreadyPatched = instructions.some(
    (inst, index) =>
      inst.opcode === OP_EQUALS &&
      isPushByteZero(instructions[index - 1]) &&
      instructions[index - 2]?.opcode === OP_GETLOCAL_2,
  );
  if (gateIndex < 0 && !gateAlreadyPatched) {
    throw new PatchError("LinkUpdater.method_3000 amount gate not found");
  }
  if (gateIndex >= 0) {
    const start = methodBody.codeStart + instructions[gateIndex].offset;
    patches.push({
      key: "charregen-admit-negative-amounts",
      start,
      end: start + 1,
      data: Buffer.from([OP_EQUALS]),
      detail: "LinkUpdater.method_3000 refuses only amount == 0, so negative deltas reach TakeDamage",
    });
  }

  // (B) the full-health shortcut: getlocal 4; pushbyte 0; ifnle L
  const guardIndex = instructions.findIndex(
    (inst, index) =>
      inst.opcode === OP_IFNLE &&
      isPushByteZero(instructions[index - 1]) &&
      isGetLocal(instructions[index - 2], 4),
  );
  const guardAlreadyPatched = instructions.some(
    (inst, index) =>
      inst.opcode === OP_JUMP &&
      instructions[index - 1]?.opcode === OP_NOP &&
      instructions[index - 2]?.opcode === OP_NOP,
  );
  if (guardIndex < 0 && !guardAlreadyPatched) {
    throw new PatchError("LinkUpdater.method_3000 full-health guard not found");
  }
  if (guardIndex >= 0) {
    const compareStart = instructions[guardIndex - 2].offset;
    const branchStart = instructions[guardIndex].offset;
    const fillLength = branchStart - compareStart;
    if (fillLength !== 4) {
      throw new PatchError(
        `Expected a 4-byte compare before the full-health guard, found ${fillLength}`,
      );
    }
    patches.push({
      key: "charregen-skip-full-health-shortcut",
      start: methodBody.codeStart + compareStart,
      end: methodBody.codeStart + branchStart,
      data: Buffer.alloc(fillLength, OP_NOP),
      detail: "LinkUpdater.method_3000 drops the `missing > 0` test that swallowed damage to a full-health target",
    });
    patches.push({
      key: "charregen-full-health-guard-unconditional",
      start: methodBody.codeStart + branchStart,
      end: methodBody.codeStart + branchStart + 1,
      data: Buffer.from([OP_JUMP]),
      detail: "LinkUpdater.method_3000 always reaches TakeDamage (ifnle -> jump, same target)",
    });
  }

  return { ctx, patches };
}

function main(): number {
  const args = parseArgs(process.argv);
  const { ctx, patches } = analyzePatch(args.swfPath);
  console.log(`SWF: ${args.swfPath}`);

  if (patches.length === 0) {
    console.log("PKTTYPE_CHAR_REGEN damage channel patch verified.");
    return 0;
  }

  for (const patch of patches) {
    console.log(`Patch: ${patch.detail}`);
  }
  if (args.verify) {
    return 1;
  }

  if (path.resolve(args.outputPath) === path.resolve(args.swfPath)) {
    ensureBackup(args.swfPath);
  }
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  ctx.path = args.outputPath;
  writeSwf(ctx, body, delta);
  console.log(`Patched SWF written to ${args.outputPath}`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
