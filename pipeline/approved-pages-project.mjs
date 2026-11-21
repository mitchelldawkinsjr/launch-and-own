// A private GitHub repository must only publish the approved static output directory.
export function matchesApprovedPagesProject(project, { name, owner, repositoryName, repositoryId, branch, projectId }) {
  const source = project?.source;
  const config = source?.config;
  const build = project?.build_config;
  return project?.name === name && typeof project.id === 'string' && project.id.length > 0 &&
    (projectId === undefined || project.id === projectId) && project.subdomain === name + '.pages.dev' &&
    project.production_branch === branch && source?.type === 'github' &&
    config?.owner?.toLowerCase() === owner.toLowerCase() &&
    config?.repo_name === repositoryName &&
    String(config?.repo_id) === String(repositoryId) &&
    config?.production_deployments_enabled !== false && project.uses_functions !== true &&
    Boolean(build && !build.build_command && ['', '/', null, undefined].includes(build.root_dir) &&
      ['public', '/public'].includes(build.destination_dir));
}
