use std::path::Path;

/// Current branch of the repository containing `cwd`, read straight from
/// .git/HEAD (no git subprocess). Detached HEAD yields the short commit id.
pub fn branch(cwd: &Path) -> Option<String> {
    let mut dir = cwd;
    loop {
        let dotgit = dir.join(".git");
        if dotgit.is_dir() {
            return head_branch(&dotgit);
        }
        if dotgit.is_file() {
            // worktree / submodule: ".git" is a file pointing at the real dir
            let text = std::fs::read_to_string(&dotgit).ok()?;
            let target = text.strip_prefix("gitdir:")?.trim();
            let target = if Path::new(target).is_absolute() { Path::new(target).to_path_buf() } else { dir.join(target) };
            return head_branch(&target);
        }
        dir = dir.parent()?;
    }
}

fn head_branch(gitdir: &Path) -> Option<String> {
    let head = std::fs::read_to_string(gitdir.join("HEAD")).ok()?;
    let head = head.trim();
    Some(match head.strip_prefix("ref: refs/heads/") {
        Some(name) => name.to_string(),
        None => head.chars().take(7).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn reads_branch_from_parent_repo() {
        let d = tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".git")).unwrap();
        std::fs::write(d.path().join(".git/HEAD"), "ref: refs/heads/feat/x\n").unwrap();
        let sub = d.path().join("a/b");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(branch(&sub).as_deref(), Some("feat/x"));
    }

    #[test]
    fn detached_head_is_short_sha() {
        let d = tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".git")).unwrap();
        std::fs::write(d.path().join(".git/HEAD"), "0123456789abcdef\n").unwrap();
        assert_eq!(branch(d.path()).as_deref(), Some("0123456"));
    }

    #[test]
    fn worktree_gitdir_file() {
        let d = tempdir().unwrap();
        let real = d.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("HEAD"), "ref: refs/heads/wt\n").unwrap();
        let wt = d.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", real.display())).unwrap();
        assert_eq!(branch(&wt).as_deref(), Some("wt"));
    }

    #[test]
    fn no_repo_is_none() {
        let d = tempdir().unwrap();
        assert_eq!(branch(d.path()), None);
    }
}
