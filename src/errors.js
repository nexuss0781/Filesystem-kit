/**
 * Errors are shared by every backend.
 *
 * A caller must be able to write `catch (error) { if (error.code === 'ENOENT') }`
 * and have that work whether the bytes came from the local disk or from a remote
 * machine, so the codes below are part of the contract rather than an
 * implementation detail of one transport.
 */

/** Thrown when a path resolves outside the root. Carries a 403 status for the HTTP layer. */
class OutsideRootError extends Error {
  constructor(requested, root) {
    super(`path is outside the root: ${requested} (root: ${root})`);
    this.name = 'OutsideRootError';
    this.code = 'EOUTSIDE';
    this.status = 403;
    this.requested = requested;
    this.root = root;
  }
}

/** HTTP status to the code a local filesystem call would have produced. */
function codeForStatus(status) {
  if (status === 403) return 'EOUTSIDE';
  if (status === 404) return 'ENOENT';
  if (status === 409) return 'EEXIST';
  if (status === 400) return 'EINVAL';
  if (status === 401) return 'E_UNAUTHORIZED';
  if (status === 413) return 'E_TOO_LARGE';
  return 'E_REMOTE';
}

/**
 * Rebuilds a local-shaped error from a remote failure.
 *
 * The server reports the code it would have used locally, so `ENOENT` from a
 * remote `read` is indistinguishable from a local one, which is the whole
 * reason a backend can be swapped without touching calling code.
 */
function errorFromRemote(payload, status, requested, root) {
  const code = payload?.code ?? codeForStatus(status);
  const message = payload?.message ?? `remote request failed with status ${status}`;
  if (code === 'EOUTSIDE') return new OutsideRootError(requested, payload?.root ?? root);
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.remote = true;
  return error;
}

export { OutsideRootError, codeForStatus, errorFromRemote };
