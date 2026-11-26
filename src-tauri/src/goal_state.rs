use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalState {
    pub thread_id: String,
    pub objective: String,
    pub status: String,
    pub token_budget: Option<u64>,
    pub tokens_used: u64,
    pub time_used_seconds: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl GoalState {
    /// A saved `goal_state` column: `None` when absent, unparsable or invalid.
    pub(crate) fn parse(raw: Option<&str>) -> Option<Self> {
        raw.and_then(|raw| serde_json::from_str::<Self>(raw).ok())
            .filter(Self::is_valid)
    }

    pub fn is_valid(&self) -> bool {
        !self.thread_id.is_empty()
            && self.thread_id.len() <= 200
            && !self.objective.trim().is_empty()
            && self.objective.len() <= 32 * 1024
            && matches!(
                self.status.as_str(),
                "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete"
            )
            && self
                .token_budget
                .is_none_or(|n| n > 0 && n <= 9_007_199_254_740_991)
            && self.tokens_used <= 9_007_199_254_740_991
            && self.time_used_seconds <= 9_007_199_254_740_991
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum GoalRequest {
    Set {
        objective: String,
        #[serde(rename = "tokenBudget")]
        token_budget: Option<u64>,
    },
    Get,
    Pause,
    Resume,
    Clear,
}

#[cfg(test)]
mod tests {
    use super::GoalState;

    #[test]
    fn parse_keeps_only_valid_saved_goals() {
        let valid = r#"{"threadId":"t","objective":"Ship","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":1,"updatedAt":2}"#;
        assert_eq!(GoalState::parse(Some(valid)).map(|goal| goal.objective), Some("Ship".into()));
        assert!(GoalState::parse(None).is_none());
        assert!(GoalState::parse(Some("not json")).is_none());
        assert!(GoalState::parse(Some(&valid.replace("active", "unknown"))).is_none());
    }
}
