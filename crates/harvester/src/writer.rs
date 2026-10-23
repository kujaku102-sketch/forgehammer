use std::fs::{create_dir_all, File};
use std::io::{self, Write};
use std::path::PathBuf;
use crate::ring_buffer::StepRecord;

/// Zero-copy binary chunk writer persisting step records directly to disk.
pub struct BinaryChunkWriter<const N: usize> {
    pub output_dir: PathBuf,
    pub part_index: usize,
    pub max_records_per_file: usize,
}

impl<const N: usize> BinaryChunkWriter<N> {
    /// Creates a new `BinaryChunkWriter` targeting `output_dir`.
    pub fn new(output_dir: PathBuf, max_records_per_file: usize) -> Self {
        Self {
            output_dir,
            part_index: 0,
            max_records_per_file,
        }
    }

    /// Writes an episode slice using zero-copy byte casting directly to binary chunks on disk.
    pub fn write_episode(&mut self, records: &[StepRecord<N>]) -> io::Result<()> {
        if records.is_empty() {
            return Ok(());
        }

        create_dir_all(&self.output_dir)?;

        let chunk_size = if self.max_records_per_file == 0 {
            records.len()
        } else {
            self.max_records_per_file
        };

        for chunk in records.chunks(chunk_size) {
            let file_name = format!("part_{:06}.bin", self.part_index);
            let file_path = self.output_dir.join(file_name);
            let mut file = File::create(&file_path)?;

            let ptr = chunk.as_ptr() as *const u8;
            let byte_len = chunk.len() * core::mem::size_of::<StepRecord<N>>();
            // SAFETY: StepRecord is #[repr(C, align(16))] with only POD types,
            // valid for reads up to byte_len across the lifetime of chunk.
            let byte_slice = unsafe { core::slice::from_raw_parts(ptr, byte_len) };

            file.write_all(byte_slice)?;
            file.flush()?;
            self.part_index += 1;
        }

        Ok(())
    }
}
