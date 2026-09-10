const key = (projectId: string) => `aurex.model.${projectId}`;

export function getPreferredModel(projectId: string): string | null {
  try {
    return localStorage.getItem(key(projectId));
  } catch {
    return null;
  }
}

export function setPreferredModel(projectId: string, model: string): void {
  try {
    localStorage.setItem(key(projectId), model);
  } catch {
    /* ignore */
  }
}
