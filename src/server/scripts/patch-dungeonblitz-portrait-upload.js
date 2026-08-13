#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGETS = [
    {
        swf: path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf')
    }
];

// Host class choice is forced, not stylistic. class_133 already owns the paperdoll headshot
// renderer (method_659) AND its static method_1956 is called unconditionally from Game's tick,
// so solo players are covered too. It is also the only viable host that survives an FFDec AS3
// round-trip: ScreenArmory fails to recompile (`null.length` decompiler artifacts), and
// recompiling class_127 shifts its register allocation enough to break the pcode assertions in
// patch-dungeonblitz-chat-commands.js --verify.
const TARGET_CLASS = 'class_133';

// ORDERING: -importScript rebuilds the whole ABC, which reverts the raw-ABC byte patches
// applied by the swfPatchUtils-based scripts. Run this patch BEFORE those, or re-run them
// afterwards. patch-dungeonblitz-forge-charm-durations.ts is the one this reverts today;
// `npm run test:regression` (open_issue_client_asset_regression) is what catches it.
//
// This is not hypothetical and it is not free: every run of this script that actually
// rewrites the SWF (either pass) silently un-applies that patch, and the SWF then ships
// with a charm-duration regression nobody typed. After any run that prints "Patched" or
// "Repaired", re-apply the byte patches and re-check:
//
//     npx ts-node scripts/patch-dungeonblitz-forge-charm-durations.ts
//     npx ts-node scripts/patch-dungeonblitz-gear-tooltip-drop-source.ts
//     npx ts-node test/open_issue_client_asset_regression.ts
//
// Re-applying rewrites the SWF again, so run THIS script once more afterwards purely to
// re-sync index.html's clientrev to the final bytes -- both passes no-op and only the cache
// token moves. A correct SWF behind a stale token reaches nobody.

// method_659 renders the party-frame headshot at 56px for the HUD. 200px is the same
// paperdoll capture at a size worth embedding in a Discord widget.
const PORTRAIT_CAPTURE_SIZE = 200;
// Re-capture is gated on the entType changing (i.e. gear/appearance changed); this is only a
// floor so a churning entType cannot turn the tick into an upload loop.
const PORTRAIT_THROTTLE_MS = 60000;

const IMPORTS = [
    'import flash.display.PNGEncoderOptions;',
    'import flash.events.Event;',
    'import flash.events.IOErrorEvent;',
    'import flash.events.SecurityErrorEvent;',
    'import flash.net.URLLoader;',
    'import flash.net.URLRequest;',
    'import flash.net.URLRequestMethod;',
    'import flash.utils.ByteArray;',
    'import flash.utils.getTimer;'
];

const IMPORT_ANCHOR = '   import flash.display.Bitmap;';

const STATE_FIELDS = [
    '      private static var var_9700:Object = null;',
    '      ',
    `      private static var var_9701:int = -${PORTRAIT_THROTTLE_MS};`,
    '      ',
    ''
].join('\n');

const STATE_FIELDS_ANCHOR = '      internal var var_1:Game;';

const TICK_ANCHOR = [
    '      public static function method_1956(param1:Game) : void',
    '      {',
    '         var _loc2_:class_133 = null;'
].join('\n');

const PATCHED_TICK = [
    '      public static function method_1956(param1:Game) : void',
    '      {',
    '         var _loc2_:class_133 = null;',
    '         method_9702(param1);'
].join('\n');

const HELPER = [
    '      public static function method_9702(param1:Game) : void',
    '      {',
    '         var _loc2_:Entity = null;',
    '         var _loc3_:Array = null;',
    '         var _loc4_:Bitmap = null;',
    '         var _loc5_:ByteArray = null;',
    '         var _loc6_:URLRequest = null;',
    '         var _loc7_:URLLoader = null;',
    '         if(!param1)',
    '         {',
    '            return;',
    '         }',
    '         _loc2_ = param1.clientEnt;',
    '         if(!_loc2_ || !_loc2_.entType || !param1.clientEntName)',
    '         {',
    '            return;',
    '         }',
    '         if(var_9700 == _loc2_.entType)',
    '         {',
    '            return;',
    '         }',
    `         if(getTimer() - var_9701 < ${PORTRAIT_THROTTLE_MS})`,
    '         {',
    '            return;',
    '         }',
    '         var_9700 = _loc2_.entType;',
    '         var_9701 = getTimer();',
    `         _loc3_ = method_659(_loc2_.entType,${PORTRAIT_CAPTURE_SIZE},param1);`,
    '         _loc4_ = _loc3_[0];',
    '         if(!_loc4_ || !_loc4_.bitmapData)',
    '         {',
    '            return;',
    '         }',
    '         _loc5_ = _loc4_.bitmapData.encode(_loc4_.bitmapData.rect,new PNGEncoderOptions());',
    '         _loc6_ = new URLRequest("/api/portrait?name=" + encodeURIComponent(param1.clientEntName));',
    '         _loc6_.method = URLRequestMethod.POST;',
    '         _loc6_.contentType = "application/octet-stream";',
    '         _loc6_.data = _loc5_;',
    '         _loc7_ = new URLLoader();',
    '         _loc7_.addEventListener(IOErrorEvent.IO_ERROR,method_9703);',
    '         _loc7_.addEventListener(SecurityErrorEvent.SECURITY_ERROR,method_9703);',
    '         _loc7_.load(_loc6_);',
    '      }',
    '      ',
    '      private static function method_9703(param1:Event) : void',
    '      {',
    '      }',
    '      ',
    ''
].join('\n');

const HELPER_ANCHOR = '      public static function method_956(param1:Game, param2:Vector.<class_133>, param3:Boolean) : void';

// PASS 2 -- collateral repair, not an optional extra.
//
// class_133 ships control-flow-flattened (opaque `local8 = false` / `local9 = true` predicates),
// and the AS3 round trip in pass 1 does not survive it inside method_1570: FFDec recompiles the
// party-frame tick with the three headshot layers hard-set to `false` and the HP bar pinned to
// `gotoAndStop(0)`, so every party member's frame renders as an empty portrait with no health.
// The original bytecode (verified against the pre-patch SWF's p-code) is:
//
//     hp = int(currHP / maxHP * 100)
//     var_580[0].visible = hp > 30      // healthy headshot
//     var_580[1].visible = 0 < hp <= 30 // hurt headshot
//     var_580[2].visible = hp <= 0      // dead headshot
//     am_HPBar.gotoAndStop(clamp(hp, 1, 100))
//
// Pass 2 re-exports the now-deobfuscated class and writes that logic back. It is a plain text
// substitution because after pass 1 the class decompiles cleanly, so this round trip is stable
// and idempotent.
const BROKEN_TICK = [
    '            var _loc5_:int = int(_loc2_.currHP / _loc2_.maxHP * 100);',
    '            if(_loc5_ <= 0)',
    '            {',
    '               var _loc4_:Boolean = true;',
    '            }',
    '            else',
    '            {',
    '               var _loc3_:Boolean = true;',
    '            }',
    '            this.var_580[0].visible = false;',
    '            this.var_580[1].visible = false;',
    '            this.var_580[2].visible = false;',
    '            _loc5_ = 1;',
    '            _loc1_.gotoAndStop(0);'
].join('\n');

const REPAIRED_TICK = [
    '            var _loc6_:int = int(_loc2_.currHP / _loc2_.maxHP * 100);',
    '            var _loc3_:Boolean = false;',
    '            var _loc4_:Boolean = false;',
    '            var _loc5_:Boolean = false;',
    '            if(_loc6_ <= 0)',
    '            {',
    '               _loc5_ = true;',
    '            }',
    '            else if(_loc6_ > 30)',
    '            {',
    '               _loc3_ = true;',
    '            }',
    '            else',
    '            {',
    '               _loc4_ = true;',
    '            }',
    '            this.var_580[0].visible = _loc3_;',
    '            this.var_580[1].visible = _loc4_;',
    '            this.var_580[2].visible = _loc5_;',
    '            if(_loc6_ > 100)',
    '            {',
    '               _loc6_ = 100;',
    '            }',
    '            if(_loc6_ < 1)',
    '            {',
    '               _loc6_ = 1;',
    '            }',
    '            _loc1_.gotoAndStop(_loc6_);'
].join('\n');

function parseArgs(argv) {
    const args = {
        ffdec: '',
        verify: false,
        swfs: []
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
            continue;
        }
        if (arg === '--swf' || arg === '-s') {
            args.swfs.push(argv[++index] || '');
            continue;
        }
        if (arg === '--verify') {
            args.verify = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    return args;
}

function printHelp() {
    console.log(
        [
            'Usage:',
            '  node src/server/scripts/patch-dungeonblitz-portrait-upload.js [--verify] [--swf <path>] [--ffdec <path>]',
            '',
            'Defaults:',
            `  exports and patches ${TARGET_CLASS} in the served DungeonBlitz SWF so the game tick`,
            `  captures the local player's ${PORTRAIT_CAPTURE_SIZE}px paperdoll headshot and POSTs it to`,
            '  /api/portrait, once per appearance change, for the Discord widget.'
        ].join('\n')
    );
}

function resolveRepoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(repoRoot, value) {
    if (!value) {
        return '';
    }
    if (path.isAbsolute(value)) {
        return value;
    }
    return path.join(repoRoot, value);
}

function detectFfdec(repoRoot, preferred) {
    const candidates = [];
    if (preferred) {
        candidates.push(resolvePath(repoRoot, preferred));
    }

    candidates.push(
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec-cli.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar'
    );

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return '';
}

function runFfdec(ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    const basename = path.basename(resolved).toLowerCase();

    if (basename.endsWith('.jar')) {
        execFileSync('java', ['-jar', resolved, '-cli', ...args], {
            stdio: 'inherit'
        });
        return;
    }

    execFileSync(resolved, ['-cli', ...args], {
        stdio: 'inherit'
    });
}

function exportTargetClass(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', TARGET_CLASS, '-export', 'script', workRoot, swfPath]);

    const classPath = path.join(workRoot, 'scripts', `${TARGET_CLASS}.as`);
    if (!fs.existsSync(classPath)) {
        throw new Error(`FFDec export did not produce ${classPath}`);
    }

    return classPath;
}

// FFDec exports CRLF; the anchors above are authored with LF.
function normalizeNewlines(source) {
    return source.replace(/\r\n/g, '\n');
}

function isPatched(source) {
    return source.includes('public static function method_9702(param1:Game) : void');
}

function isPartyFrameRepaired(source) {
    return source.includes('this.var_580[0].visible = _loc3_;') && source.includes('_loc1_.gotoAndStop(_loc6_);');
}

/**
 * Returns the repaired source, or '' when there is nothing to do. Throws when the class is
 * neither already repaired nor carrying the exact block pass 1 is known to produce -- a silent
 * no-op here would ship the blank-portrait bug again.
 */
function repairPartyFrameTick(rawSource, swfPath) {
    const source = normalizeNewlines(rawSource);
    if (isPartyFrameRepaired(source)) {
        return '';
    }
    if (!source.includes(BROKEN_TICK)) {
        throw new Error(
            `${path.basename(swfPath)}: class_133.method_1570 matches neither the repaired nor the ` +
            'known-broken party-frame block. Re-derive the block before shipping.'
        );
    }

    return source.replace(BROKEN_TICK, REPAIRED_TICK);
}

function verifyPatchedClass(source, swfPath) {
    if (!isPatched(source)) {
        throw new Error(`${path.basename(swfPath)} is missing the portrait capture helper.`);
    }
    if (!source.includes('method_9702(param1);')) {
        throw new Error(`${path.basename(swfPath)} does not call the portrait capture from the game tick.`);
    }
    if (!source.includes(`method_659(_loc2_.entType,${PORTRAIT_CAPTURE_SIZE},param1)`)) {
        throw new Error(`${path.basename(swfPath)} is missing the paperdoll headshot capture call.`);
    }
    if (!source.includes('new PNGEncoderOptions()')) {
        throw new Error(`${path.basename(swfPath)} is missing the PNG encode step.`);
    }
    if (!source.includes('"/api/portrait?name=" + encodeURIComponent(param1.clientEntName)')) {
        throw new Error(`${path.basename(swfPath)} is missing the portrait upload request.`);
    }
    if (!source.includes('if(var_9700 == _loc2_.entType)')) {
        throw new Error(`${path.basename(swfPath)} is missing the appearance-change guard.`);
    }
    if (!new RegExp(`getTimer\\(\\) - var_9701 < ${PORTRAIT_THROTTLE_MS}`).test(source)) {
        throw new Error(`${path.basename(swfPath)} is missing the portrait upload throttle.`);
    }
    if (!isPartyFrameRepaired(source)) {
        throw new Error(
            `${path.basename(swfPath)} has the recompiled party-frame tick: headshots and party ` +
            'HP bars render empty. Re-run this patch without --verify.'
        );
    }
}

function patchSource(rawSource, swfPath) {
    let source = normalizeNewlines(rawSource);
    if (isPatched(source)) {
        return source;
    }

    for (const [anchor, label] of [
        [IMPORT_ANCHOR, 'import'],
        [STATE_FIELDS_ANCHOR, 'instance field'],
        [TICK_ANCHOR, 'method_1956 tick'],
        [HELPER_ANCHOR, 'method_956']
    ]) {
        if (!source.includes(anchor)) {
            throw new Error(`${path.basename(swfPath)} has an unexpected ${label} block.`);
        }
    }

    const missingImports = IMPORTS.filter((entry) => !source.includes(entry));
    source = source.replace(
        IMPORT_ANCHOR,
        [IMPORT_ANCHOR, ...missingImports.map((entry) => `   ${entry}`)].join('\n')
    );

    source = source.replace(STATE_FIELDS_ANCHOR, `${STATE_FIELDS}${STATE_FIELDS_ANCHOR}`);
    source = source.replace(TICK_ANCHOR, PATCHED_TICK);
    return source.replace(HELPER_ANCHOR, `${HELPER}${HELPER_ANCHOR}`);
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-portrait-upload',
        path.basename(swfPath, path.extname(swfPath))
    );
    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });

    const scriptsDir = path.join(workRoot, 'scripts');

    // Pass 1: inject the capture helper into the shipped (obfuscated) class.
    let classPath = exportTargetClass(ffdecPath, workRoot, swfPath);
    let source = normalizeNewlines(fs.readFileSync(classPath, 'utf8'));
    if (!isPatched(source)) {
        fs.writeFileSync(classPath, patchSource(source, swfPath));
        runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptsDir]);
        fs.copyFileSync(patchedSwfPath, swfPath);
        console.log(`Patched portrait capture in ${swfPath}`);
    } else {
        console.log(`Portrait capture already present in ${swfPath}`);
    }

    // Pass 2: repair what pass 1's recompile cost the party frame. Always runs, including on a
    // SWF that was patched by an earlier version of this script.
    const repairRoot = `${workRoot}-repair`;
    classPath = exportTargetClass(ffdecPath, repairRoot, swfPath);
    const repairedSource = repairPartyFrameTick(fs.readFileSync(classPath, 'utf8'), swfPath);
    if (repairedSource) {
        fs.writeFileSync(classPath, repairedSource);
        runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.join(repairRoot, 'scripts')]);
        fs.copyFileSync(patchedSwfPath, swfPath);
        console.log(`Repaired party-frame headshot/HP tick in ${swfPath}`);
    } else {
        console.log(`Party-frame headshot/HP tick already repaired in ${swfPath}`);
    }

    syncClientRev(repoRoot, swfPath);
}

/**
 * index.html requests the SWF at a fixed `clientrev=` token, so a browser keeps serving its
 * cached copy after the file on disk changes -- a correct patch that nobody loads. Pin it to the
 * content hash. Run this last if other scripts also rewrite the SWF.
 */
function syncClientRev(repoRoot, swfPath) {
    const indexHtml = path.join(repoRoot, 'src', 'client', 'content', 'localhost', 'index.html');
    const defaultSwf = path.join(repoRoot, TARGETS[0].swf);
    if (path.resolve(swfPath) !== defaultSwf || !fs.existsSync(indexHtml)) return;

    const digest = crypto.createHash('sha256').update(fs.readFileSync(swfPath)).digest('hex').slice(0, 12);
    const html = fs.readFileSync(indexHtml, 'utf8');
    const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
    if (updated !== html) {
        fs.writeFileSync(indexHtml, updated);
        console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
    }
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-portrait-upload-verify',
        path.basename(swfPath, path.extname(swfPath))
    );
    const classPath = exportTargetClass(ffdecPath, workRoot, swfPath);
    verifyPatchedClass(normalizeNewlines(fs.readFileSync(classPath, 'utf8')), swfPath);
    console.log(`Verified portrait capture in ${swfPath}`);
}

function main() {
    const repoRoot = resolveRepoRoot();
    const args = parseArgs(process.argv);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);

    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    }

    const requestedSwfs = new Set(
        (args.swfs.length ? args.swfs : TARGETS.map((target) => target.swf)).map((entry) => resolvePath(repoRoot, entry))
    );
    const selectedTargets = TARGETS
        .map((target) => ({ swfPath: resolvePath(repoRoot, target.swf) }))
        .filter((target) => requestedSwfs.has(target.swfPath));

    if (!selectedTargets.length) {
        throw new Error('No matching SWFs selected for patching.');
    }

    for (const target of selectedTargets) {
        if (!fs.existsSync(target.swfPath)) {
            throw new Error(`SWF not found: ${target.swfPath}`);
        }
    }

    if (args.verify) {
        for (const target of selectedTargets) {
            verifySwf(repoRoot, ffdecPath, target.swfPath);
        }
        return;
    }

    for (const target of selectedTargets) {
        patchSwf(repoRoot, ffdecPath, target.swfPath);
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
