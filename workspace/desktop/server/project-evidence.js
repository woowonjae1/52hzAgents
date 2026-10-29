const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {gitStatus} = require('./project-reader');

// Compare Git-visible dirty files to a run baseline. Never stage/reset user work.
async function projectSnapshot(store, channel) {
  const status=await gitStatus(store,channel);
  if(!status.available) return {available:false,files:{}};
  const root=await fs.realpath(store.getChannel(channel).working_dir),files={};
  for(const item of status.files.slice(0,1000)) {
    const full=path.resolve(status.dir,item.path),relative=path.relative(root,full);
    if(relative.startsWith('..') || path.isAbsolute(relative)) continue;
    try {
      const stat=await fs.lstat(full);
      if(!stat.isFile() || stat.isSymbolicLink() || stat.size>4*1024*1024) {files[relative]='unmeasured';continue;}
      const resolved=await fs.realpath(full),rel=path.relative(root,resolved);
      if(rel.startsWith('..') || path.isAbsolute(rel)) continue;
      files[relative.replace(/\\/g,'/')]=crypto.createHash('sha256').update(await fs.readFile(resolved)).digest('hex');
    } catch {files[relative.replace(/\\/g,'/')]='deleted';}
  }
  return {available:true,files,partial:status.files.length>1000};
}
function changesSince(before,after) {
  if(!before?.available || !after?.available) return [];
  return [...new Set([...Object.keys(before.files),...Object.keys(after.files)])].filter(file=>before.files[file]!==after.files[file] && after.files[file]!=='unmeasured');
}
module.exports={projectSnapshot,changesSince};
