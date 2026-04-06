use async_trait::async_trait;
use nfsserve::nfs::*;
use nfsserve::vfs::{DirEntry, NFSFileSystem, ReadDirResult, VFSCapabilities};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::daemon_client::DaemonClient;
use crate::handle_map::HandleMap;

/// CRM NFS filesystem — proxies all operations to fuse-daemon.ts via Unix socket.
pub struct CrmNfs {
    daemon: DaemonClient,
    handles: HandleMap,
    /// Write buffers keyed by file handle id
    write_bufs: Mutex<HashMap<u64, Vec<u8>>>,
    /// Monotonic counter — each readdir gets a unique cookie verifier
    /// so the NFS client never serves cached directory listings.
    cookie_counter: AtomicU64,
}

impl CrmNfs {
    pub fn new(daemon: DaemonClient) -> Self {
        Self {
            daemon,
            handles: HandleMap::new(),
            write_bufs: Mutex::new(HashMap::new()),
            cookie_counter: AtomicU64::new(1),
        }
    }

    /// Current time as NFS timestamp — used for directory attrs so the NFS
    /// client sees mtime change and re-fetches readdir instead of caching.
    fn now_nfstime() -> nfstime3 {
        let dur = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        nfstime3 {
            seconds: dur.as_secs() as u32,
            nseconds: dur.subsec_nanos(),
        }
    }

    fn make_dir_attr(&self, id: fileid3) -> fattr3 {
        let now = Self::now_nfstime();
        fattr3 {
            ftype: ftype3::NF3DIR,
            mode: 0o755,
            nlink: 2,
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
            size: 4096,
            used: 4096,
            rdev: specdata3::default(),
            fsid: 1,
            fileid: id,
            atime: now,
            mtime: now,
            ctime: now,
        }
    }

    fn make_file_attr(&self, id: fileid3, size: u64) -> fattr3 {
        let now = Self::now_nfstime();
        fattr3 {
            ftype: ftype3::NF3REG,
            mode: 0o644,
            nlink: 1,
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
            size,
            used: size,
            rdev: specdata3::default(),
            fsid: 1,
            fileid: id,
            atime: now,
            mtime: now,
            ctime: now,
        }
    }

    fn daemon_error_to_nfs(err: &str) -> nfsstat3 {
        match err {
            "ENOENT" => nfsstat3::NFS3ERR_NOENT,
            "EPERM" => nfsstat3::NFS3ERR_PERM,
            "EROFS" => nfsstat3::NFS3ERR_ROFS,
            "EINVAL" => nfsstat3::NFS3ERR_INVAL,
            "ENOSYS" => nfsstat3::NFS3ERR_NOTSUPP,
            _ => nfsstat3::NFS3ERR_IO,
        }
    }
}

#[async_trait]
impl NFSFileSystem for CrmNfs {
    fn root_dir(&self) -> fileid3 {
        1
    }

    fn capabilities(&self) -> VFSCapabilities {
        VFSCapabilities::ReadWrite
    }

    async fn lookup(&self, dirid: fileid3, filename: &filename3) -> Result<fileid3, nfsstat3> {
        let name = std::str::from_utf8(&filename.0).map_err(|_| nfsstat3::NFS3ERR_INVAL)?;

        // . and ..
        if name == "." {
            return Ok(dirid);
        }
        if name == ".." {
            let dir_path = self.handles.get_path(dirid).ok_or(nfsstat3::NFS3ERR_STALE)?;
            if dir_path.is_empty() {
                return Ok(1); // root's parent is root
            }
            let parent = dir_path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
            return Ok(self.handles.get_or_insert(parent));
        }

        let dir_path = self.handles.get_path(dirid).ok_or(nfsstat3::NFS3ERR_STALE)?;
        let child_path = if dir_path.is_empty() {
            name.to_string()
        } else {
            format!("{}/{}", dir_path, name)
        };

        // Verify it exists via getattr
        let resp = self.daemon.op("getattr", &child_path).await.map_err(|_| nfsstat3::NFS3ERR_IO)?;
        if let Some(err) = resp.get("error").and_then(|e| e.as_str()) {
            return Err(Self::daemon_error_to_nfs(err));
        }

        Ok(self.handles.get_or_insert(&child_path))
    }

    async fn getattr(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
        let path = self.handles.get_path(id).ok_or(nfsstat3::NFS3ERR_STALE)?;

        let resp = self.daemon.op("getattr", &path).await.map_err(|_| nfsstat3::NFS3ERR_IO)?;
        if let Some(err) = resp.get("error").and_then(|e| e.as_str()) {
            return Err(Self::daemon_error_to_nfs(err));
        }

        let ftype = resp.get("type").and_then(|t| t.as_str()).unwrap_or("file");
        if ftype == "dir" {
            Ok(self.make_dir_attr(id))
        } else {
            let size = resp.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
            Ok(self.make_file_attr(id, size))
        }
    }

    async fn setattr(&self, id: fileid3, setattr: sattr3) -> Result<fattr3, nfsstat3> {
        // Handle truncate (size = 0) by clearing write buffer
        if let set_size3::size(0) = setattr.size {
            let mut bufs = self.write_bufs.lock().unwrap();
            bufs.insert(id, Vec::new());
        }
        self.getattr(id).await
    }

    async fn read(&self, id: fileid3, offset: u64, count: u32) -> Result<(Vec<u8>, bool), nfsstat3> {
        let path = self.handles.get_path(id).ok_or(nfsstat3::NFS3ERR_STALE)?;

        let resp = self.daemon.op("read", &path).await.map_err(|_| nfsstat3::NFS3ERR_IO)?;
        if let Some(err) = resp.get("error").and_then(|e| e.as_str()) {
            return Err(Self::daemon_error_to_nfs(err));
        }

        let data_str = resp.get("data").and_then(|d| d.as_str()).unwrap_or("");
        let data = data_str.as_bytes();

        let off = offset as usize;
        if off >= data.len() {
            return Ok((vec![], true));
        }
        let end = std::cmp::min(off + count as usize, data.len());
        let slice = data[off..end].to_vec();
        let eof = end >= data.len();
        Ok((slice, eof))
    }

    async fn write(&self, id: fileid3, offset: u64, data: &[u8]) -> Result<fattr3, nfsstat3> {
        let path = self.handles.get_path(id).ok_or(nfsstat3::NFS3ERR_STALE)?;

        // Accumulate in write buffer
        let full_data = {
            let mut bufs = self.write_bufs.lock().unwrap();
            let buf = bufs.entry(id).or_insert_with(Vec::new);
            let end = offset as usize + data.len();
            if end > buf.len() {
                buf.resize(end, 0);
            }
            buf[offset as usize..end].copy_from_slice(data);
            String::from_utf8_lossy(buf).to_string()
        };

        // Send full content to daemon immediately (same as C helper)
        let resp = self.daemon.write_op(&path, &full_data).await.map_err(|_| nfsstat3::NFS3ERR_IO)?;
        if let Some(err) = resp.get("error").and_then(|e| e.as_str()) {
            // Clear buffer on error
            self.write_bufs.lock().unwrap().remove(&id);
            return Err(Self::daemon_error_to_nfs(err));
        }

        let size = full_data.len() as u64;
        Ok(self.make_file_attr(id, size))
    }

    async fn create(
        &self,
        dirid: fileid3,
        filename: &filename3,
        _attr: sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        let name = std::str::from_utf8(&filename.0).map_err(|_| nfsstat3::NFS3ERR_INVAL)?;
        let dir_path = self.handles.get_path(dirid).ok_or(nfsstat3::NFS3ERR_STALE)?;
        let child_path = if dir_path.is_empty() {
            name.to_string()
        } else {
            format!("{}/{}", dir_path, name)
        };

        let id = self.handles.get_or_insert(&child_path);
        // Initialize empty write buffer
        self.write_bufs.lock().unwrap().insert(id, Vec::new());
        Ok((id, self.make_file_attr(id, 0)))
    }

    async fn create_exclusive(
        &self,
        dirid: fileid3,
        filename: &filename3,
    ) -> Result<fileid3, nfsstat3> {
        let (id, _) = self.create(dirid, filename, sattr3::default()).await?;
        Ok(id)
    }

    async fn remove(&self, dirid: fileid3, filename: &filename3) -> Result<(), nfsstat3> {
        let name = std::str::from_utf8(&filename.0).map_err(|_| nfsstat3::NFS3ERR_INVAL)?;
        let dir_path = self.handles.get_path(dirid).ok_or(nfsstat3::NFS3ERR_STALE)?;
        let child_path = if dir_path.is_empty() {
            name.to_string()
        } else {
            format!("{}/{}", dir_path, name)
        };

        let resp = self.daemon.op("unlink", &child_path).await.map_err(|_| nfsstat3::NFS3ERR_IO)?;
        if let Some(err) = resp.get("error").and_then(|e| e.as_str()) {
            return Err(Self::daemon_error_to_nfs(err));
        }

        self.handles.remove_path(&child_path);
        self.write_bufs.lock().unwrap().remove(&self.handles.get_or_insert(&child_path));
        Ok(())
    }

    async fn rename(
        &self,
        _from_dirid: fileid3,
        _from_filename: &filename3,
        _to_dirid: fileid3,
        _to_filename: &filename3,
    ) -> Result<(), nfsstat3> {
        Err(nfsstat3::NFS3ERR_NOTSUPP)
    }

    async fn mkdir(
        &self,
        _dirid: fileid3,
        _dirname: &filename3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_NOTSUPP)
    }

    async fn readdir(
        &self,
        dirid: fileid3,
        start_after: fileid3,
        max_entries: usize,
    ) -> Result<ReadDirResult, nfsstat3> {
        let path = self.handles.get_path(dirid).ok_or(nfsstat3::NFS3ERR_STALE)?;

        let resp = self.daemon.op("readdir", &path).await.map_err(|_| nfsstat3::NFS3ERR_IO)?;
        if let Some(err) = resp.get("error").and_then(|e| e.as_str()) {
            return Err(Self::daemon_error_to_nfs(err));
        }

        let entries_json = resp
            .get("entries")
            .and_then(|e| e.as_array())
            .cloned()
            .unwrap_or_default();

        // Build all entries first with stable IDs
        let all: Vec<(u64, String)> = entries_json
            .iter()
            .filter_map(|v| {
                let name = v.as_str()?;
                if name.is_empty() { return None; }
                let child_path = if path.is_empty() {
                    name.to_string()
                } else {
                    format!("{}/{}", path, name)
                };
                let id = self.handles.get_or_insert(&child_path);
                Some((id, name.to_string()))
            })
            .collect();

        // Find where to start (after start_after)
        let start_idx = if start_after == 0 {
            0
        } else {
            all.iter()
                .position(|(id, _)| *id == start_after)
                .map(|i| i + 1)
                .unwrap_or(0)
        };

        let mut entries = Vec::new();
        for (id, name) in all.iter().skip(start_idx).take(max_entries) {
            // Use lightweight attrs for readdir — the NFS client will call
            // getattr separately for entries it actually needs details on.
            // This avoids N daemon round-trips per directory listing.
            let attr = if name.ends_with(".json") {
                self.make_file_attr(*id, 0)
            } else {
                self.make_dir_attr(*id)
            };
            entries.push(DirEntry {
                fileid: *id,
                name: name.as_bytes().into(),
                attr,
            });
        }

        let end = start_idx + entries.len() >= all.len();
        Ok(ReadDirResult { entries, end })
    }

    async fn symlink(
        &self,
        _dirid: fileid3,
        _linkname: &filename3,
        _symlink: &nfspath3,
        _attr: &sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_NOTSUPP)
    }

    async fn readlink(&self, _id: fileid3) -> Result<nfspath3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_NOTSUPP)
    }

    /// Unique verifier per call — the NFS client uses the cookie verifier
    /// to decide if its cached readdir is still valid. Since directory contents
    /// change via external DB writes (CLI commands), we must never let it cache.
    fn serverid(&self) -> cookieverf3 {
        self.cookie_counter.fetch_add(1, Ordering::Relaxed).to_le_bytes()
    }
}
