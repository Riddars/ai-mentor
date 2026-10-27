// Data files: the curator sees their structure and a small sample, never the whole content.

const DATA_FILE = /\.(csv|tsv|parquet|feather|xlsx?|pkl|pickle|h5|hdf5|npy|npz|sdf|mol2?|xyz|pdb|cif|smi|db|sqlite)$/i;

/** Lines of a data file `read_file` shows: the head only. */
export const DATA_PREVIEW_LINES = 20;

export function isDataFile(path: string): boolean {
  return DATA_FILE.test(path);
}
