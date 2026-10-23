//! Ore Loader: Reads raw `.bin` trajectory chunks into aligned StepRecords.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use tusk_harvester::ring_buffer::StepRecord;

/// Loads raw ore `.bin` file into a strongly-typed `Vec<StepRecord<N>>`.
pub fn load_ore<const N: usize, P: AsRef<Path>>(path: P) -> io::Result<Vec<StepRecord<N>>> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    let file_len = metadata.len() as usize;

    let record_size = std::mem::size_of::<StepRecord<N>>();
    if file_len == 0 || file_len % record_size != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "Invalid ore file size {} bytes (expected multiple of {} bytes for N={})",
                file_len, record_size, N
            ),
        ));
    }

    let num_records = file_len / record_size;
    let mut records = vec![StepRecord::<N>::ZERO; num_records];

    let byte_slice = unsafe {
        std::slice::from_raw_parts_mut(
            records.as_mut_ptr() as *mut u8,
            file_len,
        )
    };

    file.read_exact(byte_slice)?;
    Ok(records)
}
