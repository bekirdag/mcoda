import {promises as fs,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
const exec=promisify(execFile);
export const excludedNames=new Set(['node_modules','.toolchain','.gradle','.npm-cache','.cache','.git','.mcoda','build','dist','release','DerivedData','.build','Pods','.DS_Store']);
export async function provisionAppWorkspace(workspace,task){
 let environment=`# Build environment\nLinux x86_64,Node22,npm,pnpm,Python3,git,rg and isolated shell are available. All project writes must stay in this workspace. Shell network is enabled for public dependency downloads. Use run_shell with command and args separately and explicit writePaths:[\".\"] for installs/build output. Package-cache environment variables (NPM_CONFIG_CACHE, GRADLE_USER_HOME, PIP_CACHE_DIR, CARGO_HOME) point to private persistent caches outside source; preserve them. Shell HOME and /tmp are temporary and contain no host credentials.\n\nYou may use discoverable tools,including Docdex and browser tools. No paid services,host administration or external account creation. RFP.md and ENVIRONMENT.md are immutable inputs. Source starts empty; build a real app,not a report.\n\nApple Xcode/macOS is not available in this Linux build environment. Native iOS compile/simulator tests cannot run here. Only if the RFP explicitly requests a native iOS app, provide its complete native project and tests, disclose this validation limitation, and do not substitute a web app. For every other platform, follow the RFP platform requirements. External evaluation may later use a Mac.\n`;
 if(task.domain==='android'){
  const shared=process.env.CODALI_BENCH_TOOLCHAINS ?? path.join(os.homedir(),'.local/state/codali-appbuild5/toolchains');
  await fs.mkdir(path.join(workspace,'.toolchain/android-sdk'),{recursive:true});
  await exec('cp',['-a','--reflink=auto',path.join(shared,'jdk'),path.join(workspace,'.toolchain/jdk')],{maxBuffer:100000});
  for(const part of ['platforms','build-tools','platform-tools','licenses'])await exec('cp',['-a','--reflink=auto',path.join(shared,'android-sdk',part),path.join(workspace,'.toolchain/android-sdk',part)],{maxBuffer:100000});
  environment+=`\n## Android\nJDK17 is at .toolchain/jdk and Android SDK35 with build-tools34.0.0/35.0.0 is at .toolchain/android-sdk. Before Gradle calls set JAVA_HOME=\"$PWD/.toolchain/jdk\",ANDROID_HOME=\"$PWD/.toolchain/android-sdk\",PATH=\"$JAVA_HOME/bin:$PATH\" inside the shell command. Set local.properties sdk.dir to this workspace's absolute SDK path. These folders are supplied toolchains,not your deliverable. Use bash or sh to invoke your Gradle wrapper; Java is not on the default PATH. Public Maven/Gradle downloads are allowed. AGP8.7.3 with Gradle8.9,JDK17 and compileSDK35 is a compatible baseline; select a compatible Kotlin/Compose pair. No device/emulator is exposed inside this build sandbox; host evaluation can test a produced APK.\n`;
 }
 await fs.writeFile(path.join(workspace,'ENVIRONMENT.md'),environment);
 await fs.writeFile(path.join(workspace,'.docdexignore'),'node_modules/\n.toolchain/\n.gradle/\n.npm-cache/\nbuild/\ndist/\nrelease/\n');
 await fs.writeFile(path.join(workspace,'.gitignore'),'node_modules/\n.toolchain/\n.gradle/\n.npm-cache/\nbuild/\ndist/\nrelease/\nDerivedData/\n');
}
export async function snapshotWorkflowWorkspace(root){
 const files={};let count=0;
 async function walk(rel=''){
  for(const entry of await fs.readdir(path.join(root,rel),{withFileTypes:true})){
   if(excludedNames.has(entry.name))continue;
   const p=path.posix.join(rel,entry.name),absolute=path.join(root,p);
   if(++count>30000)throw Error('Source snapshot exceeded30000entries');
   if(entry.isDirectory())await walk(p);
   else if(entry.isSymbolicLink())files[p]='SYMLINK:'+await fs.readlink(absolute);
   else if(entry.isFile()){
    const hash=createHash('sha256');for await(const chunk of createReadStream(absolute))hash.update(chunk);files[p]=hash.digest('hex');
   }else files[p]='SPECIAL_FILE';
  }
 }
 await walk();return files;
}
