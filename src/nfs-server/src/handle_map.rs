use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

/// Bidirectional mapping between NFS file handles (u64) and filesystem paths.
/// Handle 1 is always the root "/". Handle 0 is reserved (NFS convention).
pub struct HandleMap {
    path_to_id: RwLock<HashMap<String, u64>>,
    id_to_path: RwLock<HashMap<u64, String>>,
    next_id: AtomicU64,
}

impl HandleMap {
    pub fn new() -> Self {
        let mut p2i = HashMap::new();
        let mut i2p = HashMap::new();
        p2i.insert(String::new(), 1); // root = ""
        i2p.insert(1, String::new());
        Self {
            path_to_id: RwLock::new(p2i),
            id_to_path: RwLock::new(i2p),
            next_id: AtomicU64::new(2),
        }
    }

    /// Get or create a handle for a path. Path should NOT have leading slash.
    pub fn get_or_insert(&self, path: &str) -> u64 {
        // Fast path: read lock
        if let Some(&id) = self.path_to_id.read().unwrap().get(path) {
            return id;
        }
        // Slow path: write lock
        let mut p2i = self.path_to_id.write().unwrap();
        if let Some(&id) = p2i.get(path) {
            return id;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        p2i.insert(path.to_string(), id);
        self.id_to_path.write().unwrap().insert(id, path.to_string());
        id
    }

    /// Look up a path by handle. Returns None if handle is unknown.
    pub fn get_path(&self, id: u64) -> Option<String> {
        self.id_to_path.read().unwrap().get(&id).cloned()
    }

    /// Remove a handle (e.g. after unlink).
    pub fn remove_path(&self, path: &str) {
        let mut p2i = self.path_to_id.write().unwrap();
        if let Some(id) = p2i.remove(path) {
            self.id_to_path.write().unwrap().remove(&id);
        }
    }
}
