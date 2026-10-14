const { execFileSync } = require('node:child_process');

function coverageDiffArgs(filename, base, git = execFileSync) {
  if(!base) return ['diff','--unified=0','--',filename];
  // Resolve to a commit before diffing, and refuse invalid refs rather than
  // quietly passing a committed checkout with zero changed lines.
  const commit = git('git',['rev-parse','--verify','--end-of-options',`${base}^{commit}`],{encoding:'utf8',stdio:'pipe'}).trim();
  return ['diff','--unified=0',commit,'--',filename];
}

module.exports = { coverageDiffArgs };
