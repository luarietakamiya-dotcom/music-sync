/** The UI owns the temporary file, including when it terminates a rendering Worker. */
export class CandidateFile {
  private readonly name = crypto.randomUUID() + '.wav';
  private readonly directory = navigator.storage.getDirectory().then(root => root.getDirectoryHandle('music-sync-candidates', { create: true }));
  private unlock?: () => void;

  readonly handle = this.directory.then(async directory => {
    // The lock survives while this tab owns B and is released by the browser on a crash.
    const prefix = 'music-sync-candidate-';
    const leased = new Promise<void>(resolve => { this.unlock = resolve; });
    const handle = new Promise<FileSystemFileHandle>((resolve, reject) => {
      void navigator.locks.request(prefix + this.name, async () => {
        resolve(await directory.getFileHandle(this.name, { create: true }));
        await leased;
      }).catch(reject);
    });
    const entries = directory as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
    for await (const name of entries.keys()) {
      if (name === this.name || !/^[0-9a-f-]{36}\.wav$/.test(name)) continue;
      await navigator.locks.request(prefix + name, { ifAvailable: true }, async lock => {
        if (lock) await directory.removeEntry(name).catch(() => {});
      });
    }
    return handle;
  });
  async discard(): Promise<void> {
    try {
      await this.handle;
      const directory = await this.directory;
      for (let attempt = 0; attempt < 5; attempt++) {
        try { await directory.removeEntry(this.name); return; }
        catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'NoModificationAllowedError') throw error;
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    } catch { /* Storage creation may have failed. */ } finally { this.unlock?.(); }
  }
}
