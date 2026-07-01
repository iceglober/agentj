//! Interactive slash commands — one registry shared by the input line (highlight + the fuzzy
//! completion popover) and the chat loop (dispatch). Port of `commands.ts` + helpers from `input.ts`.

#[derive(Debug, Clone, Copy)]
pub struct SlashCommand {
    /// Including the leading slash, e.g. "/task".
    pub name: &'static str,
    /// Whether the command expects an argument (completion appends a trailing space).
    pub takes_arg: bool,
    /// One line shown next to the name in the completion popover.
    pub summary: &'static str,
}

pub const SLASH_COMMANDS: &[SlashCommand] = &[
    SlashCommand {
        name: "/task",
        takes_arg: true,
        summary: "wipe + re-key the worktree onto a PR or branch, then start a fresh task",
    },
    SlashCommand {
        name: "/exit",
        takes_arg: false,
        summary: "quit agentj",
    },
    SlashCommand {
        name: "/quit",
        takes_arg: false,
        summary: "quit agentj",
    },
];

/// How the command token of a line should be highlighted.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum TokenClass {
    /// Not a slash command — render plainly.
    Plain,
    /// Exactly a known command.
    Exact,
    /// A valid prefix of a known command.
    Prefix,
    /// Starts with `/` but matches nothing.
    Unknown,
}

/// Split a line into (command token, remainder) and classify the token for highlighting.
pub fn classify(line: &str, cmds: &[SlashCommand]) -> (String, String, TokenClass) {
    if !line.starts_with('/') {
        return (line.to_string(), String::new(), TokenClass::Plain);
    }
    let (token, rest) = match line.find(' ') {
        Some(i) => (&line[..i], &line[i..]),
        None => (line, ""),
    };
    let class = if cmds.iter().any(|c| c.name == token) {
        TokenClass::Exact
    } else if cmds.iter().any(|c| c.name.starts_with(token)) {
        TokenClass::Prefix
    } else {
        TokenClass::Unknown
    };
    (token.to_string(), rest.to_string(), class)
}

/// Case-insensitive fuzzy subsequence score: every pattern char must appear in order in the
/// candidate. Higher is better — consecutive runs and a matching prefix score above scattered hits.
/// `None` when the pattern isn't a subsequence.
pub fn fuzzy_score(pattern: &str, candidate: &str) -> Option<i64> {
    let pat: Vec<char> = pattern.chars().flat_map(|c| c.to_lowercase()).collect();
    let cand: Vec<char> = candidate.chars().flat_map(|c| c.to_lowercase()).collect();
    if pat.is_empty() {
        return Some(0);
    }
    let mut score = 0i64;
    let mut ci = 0usize;
    let mut prev_hit: Option<usize> = None;
    for &p in &pat {
        let hit = (ci..cand.len()).find(|&i| cand[i] == p)?;
        score += 1;
        if prev_hit == Some(hit.wrapping_sub(1)) {
            score += 3; // consecutive run
        }
        if hit == 0 {
            score += 2; // anchored at the start
        }
        score -= (hit - ci) as i64; // penalize gaps
        prev_hit = Some(hit);
        ci = hit + 1;
    }
    Some(score)
}

/// Commands fuzzy-matching `pattern` (e.g. a typed `/ta` token), best score first; ties keep
/// registry order.
pub fn fuzzy_commands(pattern: &str, cmds: &'static [SlashCommand]) -> Vec<&'static SlashCommand> {
    let mut scored: Vec<(i64, usize, &SlashCommand)> = cmds
        .iter()
        .enumerate()
        .filter_map(|(i, c)| fuzzy_score(pattern, c.name).map(|s| (s, i, c)))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, _, c)| c).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_highlights() {
        assert_eq!(classify("fix the bug", SLASH_COMMANDS).2, TokenClass::Plain);
        assert_eq!(classify("/task", SLASH_COMMANDS).2, TokenClass::Exact);
        assert_eq!(classify("/ta", SLASH_COMMANDS).2, TokenClass::Prefix);
        assert_eq!(classify("/nope", SLASH_COMMANDS).2, TokenClass::Unknown);
        let (token, rest, _) = classify("/task 2720 fix", SLASH_COMMANDS);
        assert_eq!(token, "/task");
        assert_eq!(rest, " 2720 fix");
    }

    #[test]
    fn fuzzy_scoring_orders_and_filters() {
        // exact prefix beats scattered subsequence
        assert!(fuzzy_score("/ta", "/task") > fuzzy_score("/ta", "/data"));
        // subsequence match works with gaps ("tk" hits t..k in /task)
        assert!(fuzzy_score("tk", "/task").is_some());
        // not a subsequence → None
        assert!(fuzzy_score("/xyz", "/task").is_none());
        // case-insensitive
        assert!(fuzzy_score("/TA", "/task").is_some());
        // empty pattern matches everything
        assert_eq!(fuzzy_commands("", SLASH_COMMANDS).len(), SLASH_COMMANDS.len());
        // "/" matches all commands (they all start with /)
        assert_eq!(fuzzy_commands("/", SLASH_COMMANDS).len(), SLASH_COMMANDS.len());
        // "/t" ranks /task first
        assert_eq!(fuzzy_commands("/t", SLASH_COMMANDS)[0].name, "/task");
        // garbage filters everything out
        assert!(fuzzy_commands("/zzz", SLASH_COMMANDS).is_empty());
    }
}
