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
  readU30,
  u30OperandName,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const INDEX_HTML = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");

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

/**
 * class_75.OnTickScreen (the Magic Forge screen) counts the forge down as:
 *
 *   var _loc2_:uint = var_1.mMagicForgeStatus.endtime - var_1.mServerGameTime;
 *
 * The subtraction itself is fine, but the explicit uint coercion wraps the
 * moment the forge completes: -remaining becomes 2^32 - remaining, which the
 * timer formats as ~49,710 days ("40K+ days cooldown") and pushes the progress
 * bar far below zero. Every other countdown in the client (building upgrades,
 * ability research, eggs, talents, news) declares this same expression as int;
 * the forge is the lone uint, so it is the only screen that can show this.
 * Even a plain convert_i would not be enough: Game.method_70() re-coerces its
 * argument to uint, so a negative remainder would wrap right back.
 *
 * This patch clamps the signed remainder to >= 0 before the uint coercion, so
 * an elapsed forge shows 0:00 with a full bar and the normal server "charm is
 * ready" transition takes over instead of a multi-decade countdown.
 *
 * Replacement (15 bytes vs the original 3):
 *   subtract            remaining (Number)
 *   convert_i           signed int
 *   dup
 *   pushbyte 0
 *   greaterequals       remaining >= 0 ?
 *   iftrue +3           keep the positive value
 *   pop                 drop the negative value
 *   pushbyte 0
 *   convert_u           uint (0 when elapsed)
 *   setlocal2           _loc2_
 *
 * Stack: the block starts with the subtract operands ([endtime, mServerGameTime],
 * depth 2), peaks at depth 3, and leaves the stack exactly as the original
 * 3-byte tail did (one value consumed by setlocal2). The method's max_stack (6)
 * is untouched.
 *
 * One branch in the method jumps straight onto the original convert_u with a
 * value already on the stack (the compiler's hoisted `_loc3_` result; the
 * decompiler hides this path). That branch operand is repointed so it lands on
 * the patched convert_u, which keeps its original semantics: coerce whatever is
 * on the stack to uint and store into _loc2_. Every other branch whose target
 * lies past the replaced tail shifts by the length delta.
 */

// getproperty mServerGameTime; subtract; convert_u; setlocal2
const ORIGINAL_TAIL = Buffer.from([0xa1, 0x74, 0xd6]);

// The 15-byte clamp described above (iftrue +3 lands on the final convert_u).
const CLAMP_BYTES = Buffer.from([
  0xa1, // subtract
  0x73, // convert_i
  0x2a, // dup
  0x24, 0x00, // pushbyte 0
  0xb0, // greaterequals
  0x11, 0x03, 0x00, 0x00, // iftrue +3
  0x29, // pop
  0x24, 0x00, // pushbyte 0
  0x74, // convert_u
  0xd6, // setlocal2
]);

// Byte offset of the clamp's convert_u within CLAMP_BYTES, derived so the two
// cannot drift apart.
const CONVERT_U_REL = CLAMP_BYTES.indexOf(0x74);

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
        "  ts-node scripts/patch-dungeonblitz-forge-countdown-uint-wrap.ts [--verify] [--swf <path>]",
        "",
        "Patches class_75.OnTickScreen so the Magic Forge countdown clamps to 0",
        "when the forge completes instead of wrapping a uint to ~49,710 days.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function syncClientRev(swfPath: string): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) {
    return;
  }
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
  if (updated !== html) {
    fs.writeFileSync(INDEX_HTML, updated);
    console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
  }
}

function getForgeCountdownMethod(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "class_75");
  if (classIndex === null) {
    throw new PatchError("Could not find class_75 (Magic Forge screen).");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "OnTickScreen");
  if (methodIdx === null) {
    throw new PatchError("Could not find class_75.OnTickScreen.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for class_75.OnTickScreen (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  return { ctx, abc, methodBody, code };
}

function isBranchOpcode(opcode: number): boolean {
  return opcode >= 0x0c && opcode <= 0x1a;
}

interface ForgeSite {
  state: "unpatched" | "patched";
  /** index into instructions of the tail's subtract */
  tailIndex: number;
  /** index into instructions of the branch that lands on the tail convert_u */
  branchIndex: number;
  /** byte offset (relative to the method code buffer) of the patched convert_u */
  newConvertUOffset: number;
  instructions: Instruction[];
}

/**
 * Finds the countdown site and the branch that lands on its convert_u, then
 * classifies the state: "unpatched" (original uint wrap) or "patched" (clamp
 * present). Throws if the expected site cannot be found at all.
 */
function locateSite(
  methodBody: ReturnType<typeof getForgeCountdownMethod>["methodBody"],
  code: Buffer,
  abc: ReturnType<typeof parseAbc>,
): ForgeSite {
  const insts = disassemble(code, "class_75.OnTickScreen");
  const names = abc.multinameNames;

  // Locate `getproperty mServerGameTime` and classify the tail that follows it
  // by comparing bytes: the original uint wrap or the clamp.
  let tailIndex = -1;
  let state: ForgeSite["state"] = "unpatched";
  for (let index = 0; index < insts.length; index += 1) {
    const prev = insts[index - 1];
    if (!prev || prev.opcode !== 0x66 || u30OperandName(prev, names) !== "mServerGameTime") {
      continue;
    }
    const fromTail = code.subarray(insts[index].offset, insts[index].offset + CLAMP_BYTES.length);
    if (fromTail.subarray(0, ORIGINAL_TAIL.length).equals(ORIGINAL_TAIL)) {
      tailIndex = index;
      state = "unpatched";
      break;
    }
    if (fromTail.equals(CLAMP_BYTES)) {
      tailIndex = index;
      state = "patched";
      break;
    }
  }
  if (tailIndex === -1) {
    throw new PatchError("Could not find `endtime - mServerGameTime` in class_75.OnTickScreen.");
  }

  // The tail's convert_u: the second instruction of the original tail, or the
  // clamp's convert_u when patched (CONVERT_U_REL bytes past the subtract).
  const tailStart = insts[tailIndex].offset;
  const convertUOffset = state === "patched" ? tailStart + CONVERT_U_REL : insts[tailIndex + 1].offset;

  // The branch that lands on the tail's convert_u from outside the tail: the
  // compiler hoisted a value onto the stack and jumps straight past the
  // subtract into convert_u; the decompiler hides that path entirely. When
  // patched, the clamp's own iftrue also targets the convert_u, so the outer
  // branch is the one strictly before the tail.
  const branchIndex = insts.findIndex((inst) => {
    if (!isBranchOpcode(inst.opcode) || inst.offset >= tailStart) {
      return false;
    }
    const target = inst.offset + inst.size + inst.operands[0][1];
    return target === convertUOffset;
  });
  if (branchIndex === -1) {
    throw new PatchError("Could not find the branch landing on the forge countdown convert_u.");
  }

  return {
    state,
    tailIndex,
    branchIndex,
    // Byte offset of the patched convert_u in the method code buffer.
    newConvertUOffset: tailStart + CONVERT_U_REL,
    instructions: insts,
  };
}

/**
 * Simulates the emitted clamp on the operand stack the way the player's
 * verifier will, and checks the clamp's iftrue lands on the final convert_u
 * with a consistent depth. The block starts with the subtract operands
 * ([endtime, mServerGameTime], depth 2), must peak at <= 3, and must leave the
 * stack at depth 0 (setlocal2 consumes the result).
 */
function verifyClampStack(insts: Instruction[], tailIndex: number): void {
  const ops: Array<{ opcode: number; pop: number; push: number; name: string }> = [
    { opcode: 0xa1, pop: 2, push: 1, name: "subtract" },
    { opcode: 0x73, pop: 1, push: 1, name: "convert_i" },
    { opcode: 0x2a, pop: 0, push: 1, name: "dup" },
    { opcode: 0x24, pop: 0, push: 1, name: "pushbyte" },
    { opcode: 0xb0, pop: 2, push: 1, name: "greaterequals" },
    { opcode: 0x11, pop: 1, push: 0, name: "iftrue" },
    { opcode: 0x29, pop: 1, push: 0, name: "pop" },
    { opcode: 0x24, pop: 0, push: 1, name: "pushbyte" },
    { opcode: 0x74, pop: 1, push: 1, name: "convert_u" },
    { opcode: 0xd6, pop: 1, push: 0, name: "setlocal2" },
  ];

  const block = insts.slice(tailIndex, tailIndex + ops.length);
  for (let i = 0; i < ops.length; i += 1) {
    if (block[i].opcode !== ops[i].opcode) {
      throw new PatchError(
        `Clamp block opcode mismatch at index ${i}: expected 0x${ops[i].opcode.toString(16)}, got 0x${block[i].opcode.toString(16)}.`,
      );
    }
  }

  let depth = 2; // endtime, mServerGameTime
  let maxDepth = depth;
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    depth -= op.pop;
    if (depth < 0) {
      throw new PatchError(`Clamp block underflows the operand stack at ${op.name}.`);
    }
    depth += op.push;
    maxDepth = Math.max(maxDepth, depth);
    if (op.opcode === 0x11) {
      // iftrue +3 targets the final convert_u. Fall-through depth after the pop
      // is 1; the branch arrives with the same 1.
      const target = block[i].offset + block[i].size + block[i].operands[0][1];
      const convertU = block[ops.length - 2];
      if (target !== convertU.offset) {
        throw new PatchError(`Clamp iftrue lands on ${target}, expected the convert_u at ${convertU.offset}.`);
      }
      if (depth !== 1) {
        throw new PatchError(`Clamp iftrue branch depth is ${depth}, expected 1.`);
      }
    }
  }
  if (depth !== 0) {
    throw new PatchError(`Clamp block leaves ${depth} values on the stack, expected 0.`);
  }
  if (maxDepth > 3) {
    throw new PatchError(`Clamp block needs stack ${maxDepth}, expected <= 3.`);
  }
}

function writeS24At(buf: Buffer, pos: number, value: number): void {
  let encoded = value;
  if (encoded < 0) {
    encoded += 1 << 24;
  }
  buf[pos] = encoded & 0xff;
  buf[pos + 1] = (encoded >>> 8) & 0xff;
  buf[pos + 2] = (encoded >>> 16) & 0xff;
}

/**
 * Builds the patched method code: the tail replaced by the clamp, the
 * convert_u branch repointed, and every other branch shifted for the length
 * delta. Refuses to touch a method where an unknown branch points into the
 * replaced tail.
 */
function buildPatchedCode(site: ForgeSite, code: Buffer): Buffer {
  const { tailIndex, branchIndex, instructions, newConvertUOffset } = site;
  const tailStart = instructions[tailIndex].offset;
  const tailEnd = tailStart + ORIGINAL_TAIL.length;

  for (const [index, inst] of instructions.entries()) {
    if (!isBranchOpcode(inst.opcode) || index === branchIndex) {
      continue;
    }
    if (inst.offset >= tailStart && inst.offset < tailEnd) {
      continue; // replaced away
    }
    const target = inst.offset + inst.size + inst.operands[0][1];
    if (target >= tailStart && target < tailEnd) {
      throw new PatchError(`A branch at ${inst.offset} targets the replaced countdown tail (${target}); refusing to patch.`);
    }
  }

  const delta = CLAMP_BYTES.length - ORIGINAL_TAIL.length;
  const newCode = Buffer.concat([
    code.subarray(0, tailStart),
    CLAMP_BYTES,
    code.subarray(tailEnd),
  ]);

  for (const [index, inst] of instructions.entries()) {
    if (!isBranchOpcode(inst.opcode)) {
      continue;
    }
    if (inst.offset >= tailStart && inst.offset < tailEnd) {
      continue;
    }
    const newPos = inst.offset >= tailEnd ? inst.offset + delta : inst.offset;
    if (index === branchIndex) {
      writeS24At(newCode, newPos + 1, newConvertUOffset - (newPos + inst.size));
      continue;
    }
    const target = inst.offset + inst.size + inst.operands[0][1];
    const newTarget = target >= tailEnd ? target + delta : target;
    writeS24At(newCode, newPos + 1, newTarget - (newPos + inst.size));
  }

  return newCode;
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code } = getForgeCountdownMethod(swfPath);
  const site = locateSite(methodBody, code, abc);

  if (site.state === "patched") {
    verifyClampStack(site.instructions, site.tailIndex);
    if (verify) {
      console.log("Forge countdown uint-wrap patch verified.");
      return;
    }
    console.log("Forge countdown uint-wrap patch already applied.");
    return;
  }

  if (verify) {
    throw new PatchError("Forge countdown uint-wrap patch is missing; run without --verify to apply it.");
  }

  // The clamp peaks at depth 3; the original method must allow at least that.
  const [maxStack] = readU30(ctx.body, methodBody.maxStackPos, "class_75.OnTickScreen.max_stack");
  if (maxStack < 3) {
    throw new PatchError(`class_75.OnTickScreen max_stack is ${maxStack}; the clamp needs 3.`);
  }

  const newCode = buildPatchedCode(site, code);
  const delta = newCode.length - code.length;

  const patches: BytePatch[] = [
    {
      key: "class_75.OnTickScreen.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: newCode,
      detail: `replace countdown tail with clamp (${code.length} -> ${newCode.length} bytes)`,
    },
    {
      key: "class_75.OnTickScreen.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(newCode.length),
      detail: `update class_75.OnTickScreen code length to ${newCode.length}`,
    },
  ];

  ensureBackup(swfPath);
  const { body, delta: appliedDelta } = applyPatchesToBody(ctx.body, patches);
  if (appliedDelta !== delta) {
    throw new PatchError(`Patch delta ${appliedDelta} does not match expected ${delta}.`);
  }
  writeSwf(ctx, body, appliedDelta);

  // Re-parse and assert the result end to end.
  const after = getForgeCountdownMethod(swfPath);
  const afterSite = locateSite(after.methodBody, after.code, after.abc);
  if (afterSite.state !== "patched") {
    throw new PatchError("Forge countdown uint-wrap patch did not verify after write.");
  }
  verifyClampStack(afterSite.instructions, afterSite.tailIndex);

  // The repointed convert_u branch must now land on the clamp's convert_u.
  const branch = afterSite.instructions[afterSite.branchIndex];
  if (branch.offset + branch.size + branch.operands[0][1] !== afterSite.newConvertUOffset) {
    throw new PatchError(
      `Convert_u branch lands on ${branch.offset + branch.size + branch.operands[0][1]}, expected the clamp convert_u at ${afterSite.newConvertUOffset}.`,
    );
  }

  syncClientRev(swfPath);
  console.log("Forge countdown uint-wrap patch applied.");
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
