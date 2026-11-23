function sameGitHubId(value, expected) {
  const isId = id => (typeof id === 'number' || (typeof id === 'string' && /^[1-9]\d*$/.test(id)))
    && Number.isSafeInteger(Number(id)) && Number(id) > 0;
  return isId(value) && isId(expected) && String(value) === String(expected);
}

// A private GitHub repository must only publish the approved static output directory.
export function matchesApprovedPagesProject(project, { name, owner, ownerId, repositoryName, repositoryId, branch, projectId }) {
  const source = project?.source;
  const config = source?.config;
  const build = project?.build_config;
  return project?.name === name && typeof project.id === 'string' && project.id.length > 0 &&
    (projectId === undefined || project.id === projectId) && project.subdomain === name + '.pages.dev' &&
    project.production_branch === branch && source?.type === 'github' &&
    typeof owner === 'string' && typeof config?.owner === 'string' && config.owner.toLowerCase() === owner.toLowerCase() &&
    (ownerId === undefined || config.owner_id == null || sameGitHubId(config.owner_id, ownerId)) &&
    config?.repo_name === repositoryName &&
    sameGitHubId(config.repo_id, repositoryId) &&
    config?.production_deployments_enabled !== false && project.uses_functions !== true &&
    Boolean(build && !build.build_command && ['', '/', null, undefined].includes(build.root_dir) &&
      ['public', '/public'].includes(build.destination_dir));
}
