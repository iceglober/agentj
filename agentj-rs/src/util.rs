//! Small shared helpers.

/// HOME is process-global; every test that mutates it (session TempHome) or does a write-then-read
/// through it (workspace notes, global skills) serializes here, or a concurrent flip breaks it.
#[cfg(test)]
pub(crate) static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The first non-blank line of `s`, trimmed, capped at `max` characters (not bytes).
/// Pass `usize::MAX` for no cap.
pub fn first_line(s: &str, max: usize) -> String {
    let line = s
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    if max == usize::MAX {
        line.to_string()
    } else {
        line.chars().take(max).collect()
    }
}

/// Whether a `user`-role message in the durable history was injected by the harness rather than
/// typed: job nudges (`[job …]`), the interrupt orientation note (`[note: …]`), and the
/// frontier-resume block. Transcript replay renders these as dim notes, not user cards.
pub fn is_injected_user_text(text: &str) -> bool {
    text.starts_with('[') || text.starts_with(crate::agent::RESUME_PREFIX)
}

/// `s` unchanged when it fits, else its first `max` characters with a trailing ellipsis.
pub fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

/// Keep the head and tail of an over-long text, with an omission marker between (char boundaries,
/// not bytes). Long tool output keeps its start (where answers usually sit) and its end (where
/// errors usually sit).
pub fn head_tail(text: &str, head: usize, tail: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= head + tail {
        return text.to_string();
    }
    let omitted = chars.len() - head - tail;
    let h: String = chars[..head].iter().collect();
    let t: String = chars[chars.len() - tail..].iter().collect();
    format!("{h}\n… [{omitted} chars omitted] …\n{t}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_line_trims_caps_and_skips_blank_lines() {
        assert_eq!(first_line("  \n\n  hello world  \nmore", 5), "hello");
        assert_eq!(first_line("  hello  ", usize::MAX), "hello");
        assert_eq!(first_line("", 10), "");
        assert_eq!(first_line("\n\n", 10), "");
        // char-based cap, not byte-based
        assert_eq!(first_line("héllo", 3), "hél");
    }
}
