// The East Wing's hostiles are drawn by whichever client is looking at them, because each
// client spawns them itself from the room's authored cues. That makes them invisible to the
// server: `Entity.var_38` is the class_122 server-driven-entity record, created only for an
// entity the server sent through 0x0F, and both `LinkUpdater.method_1018` (0x0D destroy) and
// `LinkUpdater.method_1072` (0x07 incremental update) return early when it is null. So a
// server-decided death cannot be delivered at all, and two players see two different runs.
//
// This is the client half of the fix: hold every hostile cue in the four East Wing rooms so
// the client draws none of them, leaving the server free to send all 35 as real remote
// entities. `Level.method_1130` already honours the flag --
// `if (cue.bHoldSpawn) { cue.bDoNotAutoSpawn = true; }` -- and `Room`'s auto-spawn loop skips
// every cue carrying `bDoNotAutoSpawn`.
//
// NEVER SHIP THIS WITHOUT THE SERVER HALF, or the rooms are empty. The server half is
// `EntityHandler.FIRST_SIGHT_SERVER_AUTHORITY_HOSTILE_LEVELS` holding JC_Mini2 and
// JC_Mini2Hard, fed by `src/server/data/dungeonSpawns/levelsJC_the_east_wing.enemies.json`.
// Ship the reverse order and every enemy is drawn twice.
//
// WHY THE 2026-07-24 ATTEMPT ONLY CAUGHT ~16 OF 34. That version walked the display list
// calling `removeChild` as it went. Mutating the child list while iterating it by index
// skips every second child, which is exactly the ~50% hit rate that was observed and was
// misread at the time as a timing problem -- "the sweep runs before some children exist".
// It is not: reading the room sprites' PlaceObject tags directly shows all 37 cues sit on
// frame 1 as direct children, so there is nothing to wait for. This version collects the
// children first and then acts on the snapshot, and never removes anything.
//
// Two exclusions, both load-bearing:
//   * `am_Boss` (ac_TowerGuard2 in room 3). Room 3 drives the whole encounter through that
//     cue -- Defeated(), AddBuff, Skit, cutSceneStartBoss/cutSceneDefeatBoss -- so holding
//     it breaks the fight. The boss stays client-spawned and the server must not draw it.
//   * `ac_TreasureChestEmpty` (2 in room 4). The server does not send chests, so holding
//     these would delete the room's loot.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOM_CLASSES = [
  'a_Room_JCMini2_01',
  'a_Room_JCMini2_02',
  'a_Room_JCMini2_03',
  'a_Room_JCMini2_04'
];
const MARKER = 'EastWingSuppressClientCues';
const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'LevelsJC.swf');

function usage() {
  console.log([
    'Usage:',
    '  node src/server/scripts/patch-levelsjc-east-wing-suppress-client-cues.js [--verify] [--swf <path>] [--ffdec <path>]',
    '',
    'Holds every hostile cue in The East Wing so the server can own the enemies.',
    'Requires the server half; see the header comment.'
  ].join('\n'));
}

function parseArgs(argv) {
  const args = { swf: DEFAULT_SWF, ffdec: '', verify: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--swf' || arg === '--swf-path') {
      args.swf = argv[++index] || args.swf;
    } else if (arg === '--ffdec' || arg === '-f') {
      args.ffdec = argv[++index] || '';
    } else if (arg === '--verify' || arg === '--dry-run') {
      args.verify = true;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function resolveRepoRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(repoRoot, maybeRelative) {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.join(repoRoot, maybeRelative);
}

function detectFfdec(repoRoot, preferred) {
  const candidates = [];
  if (preferred) {
    candidates.push(resolvePath(repoRoot, preferred));
  }
  if (process.env.FFDEC_PATH) {
    candidates.push(process.env.FFDEC_PATH);
  }
  candidates.push(
    path.join(repoRoot, 'build', 'tools', 'ffdec_25.0.0', 'ffdec-cli.exe'),
    path.join(repoRoot, 'build', 'tools', 'ffdec_25.0.0', 'ffdec-cli.jar'),
    'C:\\Program Files (x86)\\FFDec\\ffdec-cli.exe',
    'C:\\Program Files\\FFDec\\ffdec-cli.exe'
  );
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function ensureFfdecHome(repoRoot) {
  const ffdecHome = path.join(repoRoot, 'build', 'ffdec-home');
  fs.mkdirSync(path.join(ffdecHome, 'JPEXS', 'FFDec', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(ffdecHome, 'LocalAppData'), { recursive: true });
  return ffdecHome;
}

function runFfdec(ffdecPath, args) {
  const resolved = path.resolve(ffdecPath);
  const repoRoot = resolveRepoRoot();
  const ffdecHome = ensureFfdecHome(repoRoot);
  const env = {
    ...process.env,
    APPDATA: ffdecHome,
    HOME: ffdecHome,
    LOCALAPPDATA: path.join(ffdecHome, 'LocalAppData'),
    USERPROFILE: ffdecHome
  };
  if (resolved.toLowerCase().endsWith('.jar')) {
    execFileSync('java', [`-Duser.home=${ffdecHome}`, '-jar', resolved, '-cli', ...args], { env, stdio: 'inherit' });
    return;
  }
  execFileSync(resolved, args, { env, stdio: 'inherit' });
}

function exportRoomScripts(ffdecPath, workRoot, swfPath) {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });
  runFfdec(ffdecPath, ['-selectclass', ROOM_CLASSES.join(','), '-export', 'script', workRoot, swfPath]);

  const paths = [];
  for (const className of ROOM_CLASSES) {
    const roomPath = path.join(workRoot, 'scripts', `${className}.as`);
    if (!fs.existsSync(roomPath)) {
      throw new Error(`FFDec export did not produce ${roomPath}`);
    }
    paths.push({ className, roomPath });
  }
  return paths;
}

// Collect first, then act. Walking `numChildren` while mutating the display list is what
// made the previous attempt miss half the cues.
function suppressionMethod(eol) {
  return [
    '      ',
    `      public function ${MARKER}() : void`,
    '      {',
    '         var _loc4_:String = null;',
    '         var _loc5_:* = undefined;',
    '         var _loc1_:Array = [];',
    '         var _loc2_:int = 0;',
    '         var _loc3_:int = int(this.numChildren);',
    '         while(_loc2_ < _loc3_)',
    '         {',
    '            _loc1_.push(this.getChildAt(_loc2_));',
    '            _loc2_++;',
    '         }',
    '         for each(_loc5_ in _loc1_)',
    '         {',
    '            _loc4_ = getQualifiedClassName(_loc5_);',
    '            if(_loc4_.indexOf("ac_") == 0 && _loc4_.indexOf("Chest") < 0 && _loc4_.indexOf("Treasure") < 0 && _loc5_.name != "am_Boss")',
    '            {',
    '               _loc5_.bHoldSpawn = true;',
    '            }',
    '         }',
    '      }'
  ].join(eol);
}

function patchRoomSource(source, className) {
  if (source.includes(`function ${MARKER}(`)) {
    return source;
  }

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const constructorMarker = `public function ${className}()`;
  const constructorAt = source.indexOf(constructorMarker);
  if (constructorAt === -1) {
    throw new Error(`Could not find the constructor of ${className}`);
  }

  const braceStart = source.indexOf('{', constructorAt);
  if (braceStart === -1) {
    throw new Error(`Could not find the constructor body of ${className}`);
  }

  let depth = 0;
  let braceEnd = -1;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        braceEnd = index;
        break;
      }
    }
  }
  if (braceEnd === -1) {
    throw new Error(`Could not find the end of the constructor of ${className}`);
  }

  const call = `         this.${MARKER}();${eol}      `;
  let patched = `${source.slice(0, braceEnd)}${call}${source.slice(braceEnd)}`;

  // Append the method just before the class's closing brace.
  const lastBrace = patched.lastIndexOf('}', patched.lastIndexOf('}') - 1);
  if (lastBrace === -1) {
    throw new Error(`Could not find the class body end of ${className}`);
  }
  patched = `${patched.slice(0, lastBrace)}${suppressionMethod(eol)}${eol}   ${patched.slice(lastBrace)}`;
  return patched;
}

function verifyRoomSource(source, className) {
  const required = [
    `public function ${MARKER}() : void`,
    `this.${MARKER}();`,
    '_loc1_.push(this.getChildAt(_loc2_));',
    '_loc5_.bHoldSpawn = true;',
    '_loc5_.name != "am_Boss"'
  ];
  for (const marker of required) {
    if (!source.includes(marker)) {
      throw new Error(`${className} is missing required marker: ${marker}`);
    }
  }
  if (/removeChild/.test(source)) {
    throw new Error(`${className} calls removeChild; that is what made the 2026-07-24 attempt miss half the cues`);
  }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsjc-east-wing-suppress-cues');
  const patchedSwfPath = path.join(workRoot, 'LevelsJC.patched.swf');
  const rooms = exportRoomScripts(ffdecPath, workRoot, swfPath);

  let changed = 0;
  for (const { className, roomPath } of rooms) {
    const original = fs.readFileSync(roomPath, 'utf8');
    const patched = patchRoomSource(original, className);
    if (patched !== original) {
      fs.writeFileSync(roomPath, patched, 'utf8');
      changed += 1;
    }
    verifyRoomSource(patched, className);
  }

  if (changed === 0) {
    console.log(`SWF already holds the East Wing client cues: ${swfPath}`);
    return;
  }

  const backup = `${swfPath}.bak-east-wing-cues`;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(swfPath, backup);
  }
  runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(rooms[0].roomPath)]);
  fs.copyFileSync(patchedSwfPath, swfPath);
  console.log(`Patched ${changed} East Wing room classes in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsjc-east-wing-suppress-cues-verify');
  const rooms = exportRoomScripts(ffdecPath, workRoot, swfPath);
  for (const { className, roomPath } of rooms) {
    verifyRoomSource(fs.readFileSync(roomPath, 'utf8'), className);
  }
  console.log(`Verified East Wing cue suppression in all ${rooms.length} room classes of ${swfPath}`);
}

function main() {
  const repoRoot = resolveRepoRoot();
  const args = parseArgs(process.argv);
  const swfPath = resolvePath(repoRoot, args.swf);
  const ffdecPath = detectFfdec(repoRoot, args.ffdec);

  if (!ffdecPath) {
    throw new Error('FFDec not found. Pass --ffdec, set FFDEC_PATH, or restore the repo-bundled FFDec tool.');
  }
  if (!fs.existsSync(swfPath)) {
    throw new Error(`SWF not found: ${swfPath}`);
  }

  if (args.verify) {
    verifySwf(repoRoot, ffdecPath, swfPath);
    return;
  }

  patchSwf(repoRoot, ffdecPath, swfPath);
  verifySwf(repoRoot, ffdecPath, swfPath);
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
