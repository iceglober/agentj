//! The keymap: a pure function from a keystroke (plus whether a turn is running and the current input)
//! to an `Action` the event loop can act on. Kept pure so it stays fully table-testable.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, KeyboardEnhancementFlags};

// REPORT_ALTERNATE_KEYS matters: with REPORT_ALL_KEYS_AS_ESCAPE_CODES alone, terminals report the
// BASE key for shifted input (Shift+a arrives as 'a'+SHIFT, Shift+1 as '1'+SHIFT) and capitals /
// shifted punctuation stop working. Alternate keys carry the shifted codepoint so crossterm can
// translate ('A', '!').
pub const KEYBOARD_FLAGS: KeyboardEnhancementFlags =
    KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
        .union(KeyboardEnhancementFlags::REPORT_EVENT_TYPES)
        .union(KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES)
        .union(KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS);

/// What a keystroke means, resolved so the async loop can act (some actions await).
pub enum Action {
    None,
    Quit,
    ClearInput,
    Char(char),
    Backspace,
    Delete,
    DeleteWordLeft,
    DeleteWordRight,
    DeleteToLineHome,
    DeleteToLineEnd,
    Newline,
    Left,
    Right,
    WordLeft,
    WordRight,
    Up,
    Down,
    Home,
    End,
    Complete,
    /// Ctrl-P — toggle the command menu (works while running too).
    CommandMenu,
    AbortTurn,
    /// Ctrl-C — quit on a double-tap; the loop tracks the timing.
    CtrlC,
    Submit(String),
    ScrollUp,
    ScrollDown,
    PageUp,
    PageDown,
}

pub fn key_to_action(k: KeyEvent, running: bool, input: &str) -> Action {
    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    let alt = k.modifiers.contains(KeyModifiers::ALT);
    let shift = k.modifiers.contains(KeyModifiers::SHIFT);
    let super_ = k.modifiers.contains(KeyModifiers::SUPER);
    let no_mods = k.modifiers.is_empty();
    let alt_char_word = matches!(k.code, KeyCode::Char('b' | 'B' | 'f' | 'F'));
    match k.code {
        // These work during a turn too (interrupt / quit / scroll).
        KeyCode::Esc if running => Action::AbortTurn, // Esc interrupts the running turn
        KeyCode::Char('c') if ctrl => Action::CtrlC,  // twice = quit (loop tracks the double-tap)
        KeyCode::Char('p') if ctrl => Action::CommandMenu,
        KeyCode::Char('d') if ctrl => Action::Quit,
        KeyCode::PageUp => Action::PageUp,
        KeyCode::PageDown => Action::PageDown,
        KeyCode::Up if ctrl => Action::ScrollUp,
        KeyCode::Down if ctrl => Action::ScrollDown,
        // While a turn runs the input is read-only, so plain ↑/↓ scroll the transcript (this is also
        // what mouse wheels send under alternate-scroll mode).
        KeyCode::Up if running && no_mods => Action::ScrollUp,
        KeyCode::Down if running && no_mods => Action::ScrollDown,
        // Below here: ignored while a turn runs, except terminals that encode ⌥←/→ as Esc+b/f.
        _ if running && !alt_char_word => Action::None,
        KeyCode::Esc => Action::ClearInput, // idle: Esc clears the input line
        // Newline chords for multi-line input (Enter alone submits).
        KeyCode::Enter if alt || shift || ctrl => Action::Newline,
        KeyCode::Char('j') if ctrl => Action::Newline,
        KeyCode::Enter => Action::Submit(input.trim().to_string()),
        KeyCode::Tab if no_mods => Action::Complete,
        KeyCode::Backspace if super_ || (ctrl && !alt && !shift) => Action::DeleteToLineHome,
        KeyCode::Backspace if alt => Action::DeleteWordLeft,
        KeyCode::Backspace if no_mods => Action::Backspace,
        KeyCode::Delete if super_ => Action::DeleteToLineEnd,
        KeyCode::Delete if alt => Action::DeleteWordRight,
        KeyCode::Delete if no_mods => Action::Delete,
        // Readline chords (also cover terminals that send ⌘⌫ as ^U, ⌘⌦ as ^K, etc.).
        KeyCode::Char('u' | 'U') if ctrl => Action::DeleteToLineHome,
        KeyCode::Char('k' | 'K') if ctrl => Action::DeleteToLineEnd,
        KeyCode::Char('w' | 'W') if ctrl => Action::DeleteWordLeft,
        KeyCode::Char('a' | 'A') if ctrl => Action::Home,
        KeyCode::Char('e' | 'E') if ctrl => Action::End,
        KeyCode::Char('h' | 'H') if ctrl => Action::Backspace,
        KeyCode::Left if super_ => Action::Home,
        KeyCode::Right if super_ => Action::End,
        KeyCode::Left if alt => Action::WordLeft,
        KeyCode::Right if alt => Action::WordRight,
        KeyCode::Left if no_mods => Action::Left,
        KeyCode::Right if no_mods => Action::Right,
        KeyCode::Up if no_mods => Action::Up,
        KeyCode::Down if no_mods => Action::Down,
        KeyCode::Home if no_mods => Action::Home,
        KeyCode::End if no_mods => Action::End,
        KeyCode::Char(c) if alt && matches!(c, 'b' | 'B') => Action::WordLeft,
        KeyCode::Char(c) if alt && matches!(c, 'f' | 'F') => Action::WordRight,
        KeyCode::Char(c) if !ctrl && !alt && !super_ => {
            // Fallback for terminals that report the base key for shifted input ('a'+SHIFT):
            // uppercase alphabetics ourselves. Shifted punctuation needs REPORT_ALTERNATE_KEYS
            // (requested above) since the mapping is layout-dependent.
            let ch = if shift && c.is_lowercase() {
                c.to_uppercase().next().unwrap_or(c)
            } else {
                c
            };
            Action::Char(ch)
        }
        _ => Action::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::editor::Editor;

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    /// Drive an editor from a keystroke the way the loop does, for editing-focused tests.
    fn apply_key(editor: &mut Editor, key_event: KeyEvent, running: bool) -> Action {
        let action = key_to_action(key_event, running, editor.text());
        match action {
            Action::ClearInput => editor.clear(),
            Action::Char(c) => editor.insert_char(c),
            Action::Backspace => editor.backspace(),
            Action::Delete => editor.delete(),
            Action::DeleteWordLeft => editor.delete_word_left(),
            Action::DeleteWordRight => editor.delete_word_right(),
            Action::DeleteToLineHome => editor.delete_to_line_home(),
            Action::DeleteToLineEnd => editor.delete_to_line_end(),
            Action::Newline => editor.insert_char('\n'),
            Action::Left => editor.left(),
            Action::Right => editor.right(),
            Action::WordLeft => editor.word_left(),
            Action::WordRight => editor.word_right(),
            Action::Up => editor.up(),
            Action::Down => editor.down(),
            Action::Home => editor.home(),
            Action::End => editor.end(),
            Action::Submit(_)
            | Action::None
            | Action::Quit
            | Action::Complete
            | Action::CommandMenu
            | Action::AbortTurn
            | Action::CtrlC
            | Action::ScrollUp
            | Action::ScrollDown
            | Action::PageUp
            | Action::PageDown => {}
        }
        action
    }

    fn ed(s: &str) -> Editor {
        let mut e = Editor::default();
        e.insert_str(s);
        e
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ActionKind {
        None,
        AbortTurn,
        CtrlC,
        CommandMenu,
        Quit,
        PageUp,
        PageDown,
        ScrollUp,
        ScrollDown,
        ClearInput,
        Newline,
        Submit,
        Complete,
        DeleteToLineHome,
        DeleteWordLeft,
        Backspace,
        DeleteToLineEnd,
        DeleteWordRight,
        Delete,
        Home,
        End,
        WordLeft,
        WordRight,
        Left,
        Right,
        Up,
        Down,
        Char,
    }

    impl ActionKind {
        fn of(action: Action) -> Self {
            match action {
                Action::None => Self::None,
                Action::AbortTurn => Self::AbortTurn,
                Action::CtrlC => Self::CtrlC,
                Action::CommandMenu => Self::CommandMenu,
                Action::Quit => Self::Quit,
                Action::PageUp => Self::PageUp,
                Action::PageDown => Self::PageDown,
                Action::ScrollUp => Self::ScrollUp,
                Action::ScrollDown => Self::ScrollDown,
                Action::ClearInput => Self::ClearInput,
                Action::Newline => Self::Newline,
                Action::Submit(_) => Self::Submit,
                Action::Complete => Self::Complete,
                Action::DeleteToLineHome => Self::DeleteToLineHome,
                Action::DeleteWordLeft => Self::DeleteWordLeft,
                Action::Backspace => Self::Backspace,
                Action::DeleteToLineEnd => Self::DeleteToLineEnd,
                Action::DeleteWordRight => Self::DeleteWordRight,
                Action::Delete => Self::Delete,
                Action::Home => Self::Home,
                Action::End => Self::End,
                Action::WordLeft => Self::WordLeft,
                Action::WordRight => Self::WordRight,
                Action::Left => Self::Left,
                Action::Right => Self::Right,
                Action::Up => Self::Up,
                Action::Down => Self::Down,
                Action::Char(_) => Self::Char,
            }
        }
    }

    #[derive(Clone, Copy)]
    struct KeymapCase {
        code: KeyCode,
        modifiers: KeyModifiers,
        running: bool,
        expected: ActionKind,
    }

    const KEYMAP_CASES: &[KeymapCase] = &[
        KeymapCase { code: KeyCode::Esc, modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::AbortTurn },
        KeymapCase { code: KeyCode::Char('c'), modifiers: KeyModifiers::CONTROL, running: true, expected: ActionKind::CtrlC },
        KeymapCase { code: KeyCode::Char('p'), modifiers: KeyModifiers::CONTROL, running: true, expected: ActionKind::CommandMenu },
        KeymapCase { code: KeyCode::Char('p'), modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::CommandMenu },
        KeymapCase { code: KeyCode::Char('d'), modifiers: KeyModifiers::CONTROL, running: true, expected: ActionKind::Quit },
        KeymapCase { code: KeyCode::PageUp, modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::PageUp },
        KeymapCase { code: KeyCode::PageDown, modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::PageDown },
        KeymapCase { code: KeyCode::Up, modifiers: KeyModifiers::CONTROL, running: true, expected: ActionKind::ScrollUp },
        KeymapCase { code: KeyCode::Down, modifiers: KeyModifiers::CONTROL, running: true, expected: ActionKind::ScrollDown },
        KeymapCase { code: KeyCode::Char('b'), modifiers: KeyModifiers::ALT, running: true, expected: ActionKind::WordLeft },
        KeymapCase { code: KeyCode::Char('B'), modifiers: KeyModifiers::ALT, running: true, expected: ActionKind::WordLeft },
        KeymapCase { code: KeyCode::Char('f'), modifiers: KeyModifiers::ALT, running: true, expected: ActionKind::WordRight },
        KeymapCase { code: KeyCode::Char('F'), modifiers: KeyModifiers::ALT, running: true, expected: ActionKind::WordRight },
        KeymapCase { code: KeyCode::Up, modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::ScrollUp },
        KeymapCase { code: KeyCode::Down, modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::ScrollDown },
        KeymapCase { code: KeyCode::Enter, modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::None },
        KeymapCase { code: KeyCode::Tab, modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::None },
        KeymapCase { code: KeyCode::Left, modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::None },
        KeymapCase { code: KeyCode::Char('x'), modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::None },
        KeymapCase { code: KeyCode::Char('u'), modifiers: KeyModifiers::CONTROL, running: true, expected: ActionKind::None },
        KeymapCase { code: KeyCode::Esc, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::ClearInput },
        KeymapCase { code: KeyCode::Enter, modifiers: KeyModifiers::SHIFT, running: false, expected: ActionKind::Newline },
        KeymapCase { code: KeyCode::Enter, modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::Newline },
        KeymapCase { code: KeyCode::Enter, modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::Newline },
        KeymapCase { code: KeyCode::Char('j'), modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::Newline },
        KeymapCase { code: KeyCode::Tab, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Complete },
        KeymapCase { code: KeyCode::Backspace, modifiers: KeyModifiers::SUPER, running: false, expected: ActionKind::DeleteToLineHome },
        KeymapCase { code: KeyCode::Backspace, modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::DeleteToLineHome },
        KeymapCase { code: KeyCode::Backspace, modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::DeleteWordLeft },
        KeymapCase { code: KeyCode::Backspace, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Backspace },
        KeymapCase { code: KeyCode::Delete, modifiers: KeyModifiers::SUPER, running: false, expected: ActionKind::DeleteToLineEnd },
        KeymapCase { code: KeyCode::Delete, modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::DeleteWordRight },
        KeymapCase { code: KeyCode::Delete, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Delete },
        KeymapCase { code: KeyCode::Char('u'), modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::DeleteToLineHome },
        KeymapCase { code: KeyCode::Char('k'), modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::DeleteToLineEnd },
        KeymapCase { code: KeyCode::Char('w'), modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::DeleteWordLeft },
        KeymapCase { code: KeyCode::Char('a'), modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::Home },
        KeymapCase { code: KeyCode::Char('e'), modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::End },
        KeymapCase { code: KeyCode::Char('h'), modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::Backspace },
        KeymapCase { code: KeyCode::Left, modifiers: KeyModifiers::SUPER, running: false, expected: ActionKind::Home },
        KeymapCase { code: KeyCode::Right, modifiers: KeyModifiers::SUPER, running: false, expected: ActionKind::End },
        KeymapCase { code: KeyCode::Left, modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::WordLeft },
        KeymapCase { code: KeyCode::Right, modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::WordRight },
        KeymapCase { code: KeyCode::Left, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Left },
        KeymapCase { code: KeyCode::Right, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Right },
        KeymapCase { code: KeyCode::Up, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Up },
        KeymapCase { code: KeyCode::Down, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Down },
        KeymapCase { code: KeyCode::Home, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Home },
        KeymapCase { code: KeyCode::End, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::End },
        KeymapCase { code: KeyCode::PageUp, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::PageUp },
        KeymapCase { code: KeyCode::PageDown, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::PageDown },
        KeymapCase { code: KeyCode::Up, modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::ScrollUp },
        KeymapCase { code: KeyCode::Down, modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::ScrollDown },
        KeymapCase { code: KeyCode::Char('d'), modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::Quit },
        KeymapCase { code: KeyCode::Char('b'), modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::WordLeft },
        KeymapCase { code: KeyCode::Char('B'), modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::WordLeft },
        KeymapCase { code: KeyCode::Char('f'), modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::WordRight },
        KeymapCase { code: KeyCode::Char('F'), modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::WordRight },
        KeymapCase { code: KeyCode::Char('A'), modifiers: KeyModifiers::SHIFT, running: false, expected: ActionKind::Char },
        KeymapCase { code: KeyCode::Char(':'), modifiers: KeyModifiers::SHIFT, running: false, expected: ActionKind::Char },
        KeymapCase { code: KeyCode::Char('!'), modifiers: KeyModifiers::SHIFT, running: false, expected: ActionKind::Char },
        KeymapCase { code: KeyCode::Char('('), modifiers: KeyModifiers::SHIFT, running: false, expected: ActionKind::Char },
    ];

    #[test]
    fn keymap_table_covers_all_supported_non_submit_bindings() {
        for case in KEYMAP_CASES {
            let actual =
                ActionKind::of(key_to_action(key(case.code, case.modifiers), case.running, " hi "));
            assert_eq!(
                actual, case.expected,
                "unexpected action for {:?} with {:?} while running={} ",
                case.code, case.modifiers, case.running
            );
        }
    }

    #[test]
    fn submit_binding_trims_input() {
        assert!(matches!(
            key_to_action(key(KeyCode::Enter, KeyModifiers::NONE), false, "  hi  "),
            Action::Submit(s) if s == "hi"
        ));
    }

    #[test]
    fn running_turn_suppresses_unsupported_keys() {
        for (code, modifiers) in [
            (KeyCode::Enter, KeyModifiers::NONE),
            (KeyCode::Tab, KeyModifiers::NONE),
            (KeyCode::Left, KeyModifiers::NONE),
            (KeyCode::Char('x'), KeyModifiers::NONE),
            (KeyCode::Backspace, KeyModifiers::NONE),
            (KeyCode::Delete, KeyModifiers::NONE),
        ] {
            assert!(matches!(
                key_to_action(key(code, modifiers), true, "hi"),
                Action::None
            ));
        }
    }

    #[test]
    fn keystroke_sequence_distinguishes_submit_from_multiline_newline_chords() {
        let mut e = Editor::default();
        apply_key(&mut e, key(KeyCode::Char('a'), KeyModifiers::NONE), false);
        apply_key(&mut e, key(KeyCode::Enter, KeyModifiers::SHIFT), false);
        apply_key(&mut e, key(KeyCode::Char('b'), KeyModifiers::NONE), false);
        assert_eq!(e.text(), "a\nb");

        let submitted = apply_key(&mut e, key(KeyCode::Enter, KeyModifiers::NONE), false);
        assert!(matches!(submitted, Action::Submit(s) if s == "a\nb"));

        let mut ctrl_j = Editor::default();
        apply_key(&mut ctrl_j, key(KeyCode::Char('x'), KeyModifiers::NONE), false);
        apply_key(&mut ctrl_j, key(KeyCode::Char('j'), KeyModifiers::CONTROL), false);
        apply_key(&mut ctrl_j, key(KeyCode::Char('y'), KeyModifiers::NONE), false);
        assert_eq!(ctrl_j.text(), "x\ny");

        let mut alt_enter = Editor::default();
        apply_key(&mut alt_enter, key(KeyCode::Char('m'), KeyModifiers::NONE), false);
        apply_key(&mut alt_enter, key(KeyCode::Enter, KeyModifiers::ALT), false);
        apply_key(&mut alt_enter, key(KeyCode::Char('n'), KeyModifiers::NONE), false);
        assert_eq!(alt_enter.text(), "m\nn");

        let mut ctrl_enter = Editor::default();
        apply_key(&mut ctrl_enter, key(KeyCode::Char('p'), KeyModifiers::NONE), false);
        apply_key(&mut ctrl_enter, key(KeyCode::Enter, KeyModifiers::CONTROL), false);
        apply_key(&mut ctrl_enter, key(KeyCode::Char('q'), KeyModifiers::NONE), false);
        assert_eq!(ctrl_enter.text(), "p\nq");
    }

    #[test]
    fn shifted_printable_keystroke_sequence_preserves_text_entry() {
        let mut e = Editor::default();
        apply_key(&mut e, key(KeyCode::Char('A'), KeyModifiers::SHIFT), false);
        apply_key(&mut e, key(KeyCode::Char(':'), KeyModifiers::SHIFT), false);
        apply_key(&mut e, key(KeyCode::Char('!'), KeyModifiers::SHIFT), false);
        apply_key(&mut e, key(KeyCode::Char('('), KeyModifiers::SHIFT), false);
        assert_eq!(e.text(), "A:!(");

        let submitted = apply_key(&mut e, key(KeyCode::Enter, KeyModifiers::NONE), false);
        assert!(matches!(submitted, Action::Submit(s) if s == "A:!("));
    }

    #[test]
    fn base_key_shift_reports_uppercase() {
        // Terminals in kitty full-reporting mode without alternate keys send Shift+a as 'a'+SHIFT;
        // the keymap must uppercase it rather than insert lowercase.
        assert!(matches!(
            key_to_action(key(KeyCode::Char('a'), KeyModifiers::SHIFT), false, ""),
            Action::Char('A')
        ));
        // Already-translated capitals pass through.
        assert!(matches!(
            key_to_action(key(KeyCode::Char('Z'), KeyModifiers::SHIFT), false, ""),
            Action::Char('Z')
        ));
        // No shift → unchanged.
        assert!(matches!(
            key_to_action(key(KeyCode::Char('a'), KeyModifiers::NONE), false, ""),
            Action::Char('a')
        ));
    }

    #[test]
    fn keyboard_flags_include_alternate_keys_for_shifted_input() {
        assert!(KEYBOARD_FLAGS.contains(KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS));
    }

    #[test]
    fn keyboard_flags_request_only_needed_progressive_reporting() {
        assert!(KEYBOARD_FLAGS.contains(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES));
        assert!(KEYBOARD_FLAGS.contains(KeyboardEnhancementFlags::REPORT_EVENT_TYPES));
        assert!(KEYBOARD_FLAGS.contains(KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES));
    }

    #[test]
    fn alt_word_aliases_match_alt_arrow_word_motion() {
        let mut e = ed("one two three");
        apply_key(&mut e, key(KeyCode::Char('b'), KeyModifiers::ALT), false);
        assert_eq!(e.cursor, "one two ".len());
        apply_key(&mut e, key(KeyCode::Left, KeyModifiers::ALT), false);
        assert_eq!(e.cursor, "one ".len());
        apply_key(&mut e, key(KeyCode::Char('f'), KeyModifiers::ALT), false);
        assert_eq!(e.cursor, "one two".len());
    }

    #[test]
    fn destructive_editing_shortcuts_apply_through_actions() {
        let mut e = ed("abc def");
        apply_key(&mut e, key(KeyCode::Left, KeyModifiers::NONE), false);
        apply_key(&mut e, key(KeyCode::Backspace, KeyModifiers::SUPER), false);
        assert_eq!(e.text(), "f");
        assert_eq!(e.cursor, 0);

        let mut e = ed("abcd");
        apply_key(&mut e, key(KeyCode::Left, KeyModifiers::NONE), false);
        apply_key(&mut e, key(KeyCode::Left, KeyModifiers::NONE), false);
        apply_key(&mut e, key(KeyCode::Backspace, KeyModifiers::NONE), false);
        assert_eq!(e.text(), "acd");
        apply_key(&mut e, key(KeyCode::Delete, KeyModifiers::NONE), false);
        assert_eq!(e.text(), "ad");
    }

    #[test]
    fn cmd_delete_and_backspace_delete_to_line_edges() {
        let mut e = ed("alpha beta\ngamma delta");
        e.set_cursor("alpha be".len());
        apply_key(&mut e, key(KeyCode::Backspace, KeyModifiers::SUPER), false);
        assert_eq!(e.text(), "ta\ngamma delta");
        assert_eq!(e.cursor, 0);

        // ⌘⌫ on a later line deletes to THAT line's start, not the buffer start.
        let mut e = ed("alpha beta\ngamma delta");
        e.set_cursor("alpha beta\ngamma ".len());
        apply_key(&mut e, key(KeyCode::Backspace, KeyModifiers::SUPER), false);
        assert_eq!(e.text(), "alpha beta\ndelta");
        assert_eq!(e.cursor, "alpha beta\n".len());

        let mut e = ed("alpha beta\ngamma delta");
        e.set_cursor("alpha be".len());
        apply_key(&mut e, key(KeyCode::Delete, KeyModifiers::SUPER), false);
        assert_eq!(e.text(), "alpha be\ngamma delta");
        assert_eq!(e.cursor, "alpha be".len());
    }

    #[test]
    fn readline_chords_edit_the_line() {
        let mut e = ed("alpha beta");
        apply_key(&mut e, key(KeyCode::Char('u'), KeyModifiers::CONTROL), false);
        assert_eq!(e.text(), "");

        let mut e = ed("alpha beta");
        apply_key(&mut e, key(KeyCode::Char('a'), KeyModifiers::CONTROL), false);
        assert_eq!(e.cursor, 0);
        apply_key(&mut e, key(KeyCode::Char('k'), KeyModifiers::CONTROL), false);
        assert_eq!(e.text(), "");

        let mut e = ed("alpha beta");
        apply_key(&mut e, key(KeyCode::Char('w'), KeyModifiers::CONTROL), false);
        assert_eq!(e.text(), "alpha ");
    }

    #[test]
    fn option_delete_and_backspace_delete_words_without_crossing_lines() {
        let mut e = ed("alpha  beta\ngamma delta");
        e.set_cursor("alpha  beta".len());
        apply_key(&mut e, key(KeyCode::Backspace, KeyModifiers::ALT), false);
        assert_eq!(e.text(), "alpha  \ngamma delta");
        assert_eq!(e.cursor, "alpha  ".len());
        apply_key(&mut e, key(KeyCode::Backspace, KeyModifiers::ALT), false);
        assert_eq!(e.text(), "\ngamma delta");
        assert_eq!(e.cursor, 0);

        let mut e = ed("alpha  beta\ngamma delta");
        e.set_cursor("alpha  ".len());
        apply_key(&mut e, key(KeyCode::Delete, KeyModifiers::ALT), false);
        assert_eq!(e.text(), "alpha  \ngamma delta");
        assert_eq!(e.cursor, "alpha  ".len());
        apply_key(&mut e, key(KeyCode::Delete, KeyModifiers::ALT), false);
        assert_eq!(e.text(), "alpha   delta");
        assert_eq!(e.cursor, "alpha  ".len());
    }

    #[test]
    fn long_edit_script_preserves_expected_text_and_cursor() {
        let mut e = Editor::default();
        for _ in 0..64 {
            apply_key(&mut e, key(KeyCode::Char('a'), KeyModifiers::NONE), false);
        }
        for _ in 0..16 {
            apply_key(&mut e, key(KeyCode::Left, KeyModifiers::NONE), false);
        }
        for _ in 0..8 {
            apply_key(&mut e, key(KeyCode::Backspace, KeyModifiers::NONE), false);
        }
        apply_key(&mut e, key(KeyCode::Enter, KeyModifiers::SHIFT), false);
        for _ in 0..32 {
            apply_key(&mut e, key(KeyCode::Char('b'), KeyModifiers::NONE), false);
        }
        for _ in 0..10 {
            apply_key(&mut e, key(KeyCode::Char('f'), KeyModifiers::ALT), false);
            apply_key(&mut e, key(KeyCode::Char('b'), KeyModifiers::ALT), false);
        }
        apply_key(&mut e, key(KeyCode::Left, KeyModifiers::SUPER), false);
        apply_key(&mut e, key(KeyCode::Delete, KeyModifiers::SUPER), false);

        assert_eq!(e.text(), format!("{}\n", "a".repeat(40)));
        assert_eq!(e.cursor, "a".repeat(40).len() + 1);
    }
}
