import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    applyPatchesToBody,
    BytePatch,
    disassemble,
    ensureBackup,
    parseAbc,
    parseSwf,
    PatchError,
    writeSwf,
    writeU30
} from './swfPatchUtils';

const DEFAULT_SWF = path.resolve(
    __dirname,
    '..',
    '..',
    'client',
    'content',
    'localhost',
    'p',
    'cbp',
    'DungeonBlitz.swf'
);
const INDEX_HTML = path.resolve(__dirname, '..', '..', 'client', 'content', 'localhost', 'index.html');
const NEW_QUEST_SYMBOL = 'a_NewQuestFloater';
const NEW_QUEST_PANEL = 'am_Panel';
const CLEAR_THE_BANDITS_TITLE = 'Clear the bandits';

function encodeS24(value: number): Buffer {
    const out = Buffer.alloc(3);
    out.writeIntLE(value, 0, 3);
    return out;
}

function branch(opcode: number, fromOffset: number, targetOffset: number): Buffer {
    return Buffer.concat([Buffer.from([opcode]), encodeS24(targetOffset - (fromOffset + 4))]);
}

function pushString(index: number): Buffer {
    return Buffer.concat([Buffer.from([0x2c]), writeU30(index)]);
}

function encodeString(value: string): Buffer {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([writeU30(bytes.length), bytes]);
}

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
    let swfPath = DEFAULT_SWF;
    let verify = false;
    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--verify') {
            verify = true;
        } else if (arg === '--swf' || arg === '-s') {
            swfPath = path.resolve(argv[++index] ?? '');
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return { swfPath, verify };
}

function findNewQuestConstructor(swfPath: string) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const symbolIndex = abc.stringValues.indexOf(NEW_QUEST_SYMBOL);
    const panelIndex = abc.stringValues.indexOf(NEW_QUEST_PANEL);
    const matches = [...abc.methodBodies.values()].filter((body) => {
        const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
        try {
            const pushedStrings = disassemble(code, `new-quest-constructor-${body.methodIdx}`)
                .filter((instruction) => instruction.opcode === 0x2c)
                .map((instruction) => instruction.operands[0]?.[1]);
            return pushedStrings.includes(symbolIndex) && pushedStrings.includes(panelIndex);
        } catch {
            return false;
        }
    });
    if (matches.length !== 1) {
        throw new PatchError(`Expected one New Quest floater constructor, found ${matches.length}.`);
    }
    return { ctx, abc, body: matches[0] };
}

function buildEmptyTitleFallback(insertionOffset: number, emptyStringIndex: number, titleIndex: number): Buffer {
    const chunks: Buffer[] = [];
    let length = 0;
    const emit = (buffer: Buffer): number => {
        const offset = length;
        chunks.push(buffer);
        length += buffer.length;
        return offset;
    };
    const placeholder = (): { index: number; offset: number } => {
        const index = chunks.length;
        const offset = emit(Buffer.alloc(4));
        return { index, offset };
    };

    emit(Buffer.from([0xd1])); // getlocal1: supplied quest title
    emit(pushString(emptyStringIndex));
    const ifNotEmpty = placeholder();
    emit(pushString(titleIndex));
    const afterFallback = placeholder();
    const suppliedTitleOffset = length;
    emit(Buffer.from([0xd1]));
    const afterChoiceOffset = length;

    chunks[ifNotEmpty.index] = branch(
        0x14,
        insertionOffset + ifNotEmpty.offset,
        insertionOffset + suppliedTitleOffset
    );
    chunks[afterFallback.index] = branch(
        0x10,
        insertionOffset + afterFallback.offset,
        insertionOffset + afterChoiceOffset
    );
    return Buffer.concat(chunks);
}

function branchAdjustmentPatches(
    body: ReturnType<typeof findNewQuestConstructor>['body'],
    code: Buffer,
    replacementStart: number,
    replacementEnd: number,
    delta: number
): BytePatch[] {
    const patches: BytePatch[] = [];
    for (const instruction of disassemble(code, 'New Quest floater branches')) {
        const operand = instruction.operands[0];
        if (!operand || operand[0] !== 's24') {
            continue;
        }
        const target = instruction.offset + instruction.size + operand[1];
        let next = operand[1];
        if (instruction.offset < replacementStart && target >= replacementEnd) {
            next += delta;
        } else if (instruction.offset >= replacementEnd && target < replacementStart) {
            next -= delta;
        } else {
            continue;
        }
        patches.push({
            key: `new-quest-branch-${instruction.offset}`,
            start: body.codeStart + instruction.offset + 1,
            end: body.codeStart + instruction.offset + instruction.size,
            data: encodeS24(next),
            detail: 'adjust New Quest floater branch across title fallback'
        });
    }
    return patches;
}

function verifyBranchTargets(code: Buffer): void {
    const instructions = disassemble(code, 'New Quest floater verify');
    const offsets = new Set(instructions.map((instruction) => instruction.offset));
    offsets.add(code.length);
    for (const instruction of instructions) {
        for (const operand of instruction.operands) {
            if (operand[0] !== 's24') {
                continue;
            }
            const target = instruction.offset + instruction.size + operand[1];
            if (!offsets.has(target)) {
                throw new PatchError(`Invalid New Quest floater branch from ${instruction.offset} to ${target}.`);
            }
        }
    }
}

function hasPatch(swfPath: string): boolean {
    const { ctx, abc, body } = findNewQuestConstructor(swfPath);
    const titleIndex = abc.stringValues.indexOf(CLEAR_THE_BANDITS_TITLE);
    if (titleIndex < 0) {
        return false;
    }
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    return disassemble(code, 'New Quest floater patch check').some((instruction) =>
        instruction.opcode === 0x2c && instruction.operands[0]?.[1] === titleIndex
    );
}

function verifySwf(swfPath: string): void {
    if (!hasPatch(swfPath)) {
        throw new PatchError(`${path.basename(swfPath)} is missing the Clear the bandits New Quest title.`);
    }
    const { ctx, body } = findNewQuestConstructor(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    verifyBranchTargets(code);
    console.log(`${path.basename(swfPath)} Clear the bandits New Quest title verify ok.`);
}

function patchSwf(swfPath: string): void {
    if (hasPatch(swfPath)) {
        console.log(`${path.basename(swfPath)} already has the Clear the bandits New Quest title.`);
        return;
    }

    const { ctx, abc, body } = findNewQuestConstructor(swfPath);
    if (body.exceptionCount !== 0) {
        throw new PatchError('New Quest floater constructor has an unexpected exception table.');
    }
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const instructions = disassemble(code, 'New Quest floater insertion');
    const symbolIndex = abc.stringValues.indexOf(NEW_QUEST_SYMBOL);
    const symbolPosition = instructions.findIndex((instruction) =>
        instruction.opcode === 0x2c && instruction.operands[0]?.[1] === symbolIndex
    );
    const titleLoad = instructions[symbolPosition - 1];
    if (!titleLoad || titleLoad.opcode !== 0xd1) {
        throw new PatchError('New Quest floater does not load its title from local1.');
    }

    const titleIndex = abc.stringValues.length;
    const fallback = buildEmptyTitleFallback(titleLoad.offset, 1, titleIndex);
    const replacementStart = titleLoad.offset;
    const replacementEnd = titleLoad.offset + titleLoad.size;
    const delta = fallback.length - titleLoad.size;
    const patches: BytePatch[] = [
        {
            key: 'new-quest-title-string-count',
            start: abc.stringCountPos,
            end: abc.stringCountEnd,
            data: writeU30(abc.stringValues.length + 1),
            detail: 'reserve the Clear the bandits New Quest title'
        },
        {
            key: 'new-quest-title-string',
            start: abc.stringPoolEnd,
            end: abc.stringPoolEnd,
            data: encodeString(CLEAR_THE_BANDITS_TITLE),
            detail: 'add the Clear the bandits New Quest title'
        },
        {
            key: 'new-quest-title-code-length',
            start: body.codeLenPos,
            end: body.codeStart,
            data: writeU30(body.codeLen + delta),
            detail: 'update New Quest floater constructor code length'
        },
        {
            key: 'new-quest-title-fallback',
            start: body.codeStart + replacementStart,
            end: body.codeStart + replacementEnd,
            data: fallback,
            detail: 'use Clear the bandits when the New Quest title is empty'
        },
        ...branchAdjustmentPatches(body, code, replacementStart, replacementEnd, delta)
    ];

    ensureBackup(swfPath);
    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);
    verifySwf(swfPath);
    console.log(`${path.basename(swfPath)} patched with the Clear the bandits New Quest title.`);
}

function syncClientRevision(swfPath: string, verifyOnly: boolean): void {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(swfPath)).digest('hex').slice(0, 12);
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const expected = `clientrev=swf-${digest}`;
    if (verifyOnly) {
        if (!html.includes(expected)) {
            throw new PatchError(`index.html does not use ${expected}.`);
        }
        return;
    }
    const updated = html.replace(/clientrev=[^&`"'$]+/, expected);
    if (updated === html && !html.includes(expected)) {
        throw new PatchError('Could not update the DungeonBlitz client revision in index.html.');
    }
    if (updated !== html) {
        fs.writeFileSync(INDEX_HTML, updated, 'utf8');
    }
}

const { swfPath, verify } = parseArgs(process.argv);
if (verify) {
    verifySwf(swfPath);
    syncClientRevision(swfPath, true);
} else {
    patchSwf(swfPath);
    syncClientRevision(swfPath, false);
}
