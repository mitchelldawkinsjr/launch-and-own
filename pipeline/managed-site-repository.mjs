export function managedRepositoryDescription(slug, jobId) {
  return 'Launch & Own managed site: ' + slug + (jobId ? ' [job:' + jobId + ']' : '');
}

export function isLegacyRepositoryDescription(description, slug) {
  return description === managedRepositoryDescription(slug) ||
    description === 'Elite Site Pipeline managed site: ' + slug;
}

export function isManagedRepositoryDescription(description, slug) {
  if (isLegacyRepositoryDescription(description, slug)) return true;
  const match = typeof description === 'string' &&
    description.match(/ \[job:([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\]$/);
  return Boolean(match && description === managedRepositoryDescription(slug, match[1]));
}
