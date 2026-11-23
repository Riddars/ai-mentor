// Data files are inventory metadata only.

const DATA_FILE = /\.(csv|tsv|parquet|feather|xlsx?|pkl|pickle|h5|hdf5|npy|npz|sdf|mol2?|xyz|pdb|pdbqt|cif|smi|db|sqlite|fastq|fq|fasta|fa|fna|faa|sam|bam|cram|vcf|bcf)$/i;

export function isDataFile(path: string): boolean {
  return DATA_FILE.test(path);
}
