import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRepositoryArchive } from "@/lib/agent/run";
import { extractTarball,listRepoFiles } from "@/lib/agent/workspace";
import { getRepoInstallationId } from "@/lib/github/auth";
import { defaultBranchHead } from "@/lib/curator/memory";
const [owner,repo]=process.argv.slice(2);
if (!owner || !repo) throw new Error("Expected owner and repo");
const installationId=await getRepoInstallationId(owner,repo);
const headSha=await defaultBranchHead({owner,repo,id:0},installationId);
const dir=await mkdtemp(join(tmpdir(),"curator-load-test-"));
try {
  const archive=join(dir,"source.tar"),root=join(dir,"source");
  const partial=await prepareRepositoryArchive({owner,repo,installationId,headSha},archive,true);
  await mkdir(root);
  const extracted=await extractTarball(archive,root);
  const files=await listRepoFiles(root);
  if (!files.length) throw new Error("Empty snapshot");
  console.log({repo,headSha,files:files.length,partial,stopped:extracted.stoppedOn});
} finally { await rm(dir,{recursive:true,force:true}); }
