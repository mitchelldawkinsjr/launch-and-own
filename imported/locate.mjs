// Shared "which file holds this text" step for typed edits. Same semantics as the hosted flow
// (onboarding/imported-edit-flow.mjs): try only files whose inventory allows the kind, run the full
// validateEdits on each, and refuse when the text validates in more than one file.
// shortcut: the hosted flow still has its own inline copy; switch it to this helper in a follow-up.
import { gitBlobSha } from './bytes.mjs';
import { parseModelOutput, validateEdits } from './edits.mjs';
import { ImportedEditError } from './errors.mjs';

const strip = path => path.startsWith('public/') ? path.slice('public/'.length) : path;

/** Throws ImportedEditError('ambiguous_pages') with `.paths` when the text is on several pages. */
export async function locateTypedEdit({ files, inspection, revision, kind, find, replace, path, requestId, summary }) {
  const attempt = async relative => {
    const source = files.find(file => file.path === relative);
    if (!source) throw new ImportedEditError('kind_not_allowed');
    const contractEdits = [{ kind, path: 'public/' + relative, expectedBlobSha: await gitBlobSha(source.bytes), find, replace }];
    const proposal = parseModelOutput(JSON.stringify({ v: 1, requestId, repositoryId: revision.repositoryId, baseCommitSha: revision.commitSha, summary, edits: contractEdits }));
    const validated = await validateEdits({ baseCommitSha: revision.commitSha, files, inspection, proposal, repositoryId: revision.repositoryId });
    return { relative, contractEdits, validated };
  };
  if (path) return attempt(strip(path));
  const matches = [];
  let lastError;
  for (const relative of inspection.files.filter(file => file.editable.includes(kind)).map(file => strip(file.path))) {
    try { matches.push(await attempt(relative)); } catch (error) { lastError = error; }
  }
  if (matches.length > 1) {
    const error = new ImportedEditError('ambiguous_pages');
    error.paths = matches.map(match => match.relative);
    throw error;
  }
  if (!matches.length) throw lastError instanceof ImportedEditError && lastError.code !== 'no_match' ? lastError : new ImportedEditError('not_found_anywhere');
  return matches[0];
}
