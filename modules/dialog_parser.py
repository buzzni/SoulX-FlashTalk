"""
Dialog Parser Module for Multi-Agent Conversation
Parses structured dialog data (from frontend JSON) into generation-ready format.
"""

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Agent:
    id: str
    name: str
    face_image: str
    voice_id: str
    prompt: str = ""
    background_image: str = ""  # legacy, kept for compat
    scene_prompt: str = ""
    reference_image_paths: list = field(default_factory=list)


@dataclass
class DialogTurn:
    agent_id: str
    text: str


@dataclass
class DialogScript:
    agents: dict  # agent_id -> Agent
    turns: list  # list of DialogTurn

    def validate(self) -> list:
        """Validate dialog script. Returns list of error messages."""
        errors = []
        if len(self.agents) < 2:
            errors.append("최소 2명의 에이전트가 필요합니다")
        if len(self.turns) == 0:
            errors.append("최소 1개의 대화 턴이 필요합니다")
        for i, turn in enumerate(self.turns):
            if turn.agent_id not in self.agents:
                errors.append(f"턴 {i+1}: 알 수 없는 에이전트 '{turn.agent_id}'")
            if not turn.text.strip():
                errors.append(f"턴 {i+1}: 빈 텍스트")
        return errors


def parse_dialog_json(data: dict) -> DialogScript:
    """
    Parse dialog from API JSON format.

    Expected format:
    {
        "agents": [
            {"id": "A", "name": "김민수", "face_image_path": "...", "voice_id": "..."},
            {"id": "B", "name": "이수진", "face_image_path": "...", "voice_id": "..."}
        ],
        "dialog": [
            {"agent": "A", "text": "안녕하세요!"},
            {"agent": "B", "text": "반갑습니다!"}
        ]
    }
    """
    agents = {}
    for agent_data in data.get("agents", []):
        agent = Agent(
            id=agent_data["id"],
            name=agent_data.get("name", agent_data["id"]),
            face_image=agent_data.get("face_image_path", ""),
            voice_id=agent_data.get("voice_id", ""),
            prompt=agent_data.get("prompt", ""),
            background_image=agent_data.get("background_image_path", ""),
            scene_prompt=agent_data.get("scene_prompt", ""),
            reference_image_paths=agent_data.get("reference_image_paths", []),
        )
        agents[agent.id] = agent

    turns = []
    for turn_data in data.get("dialog", []):
        turn = DialogTurn(
            agent_id=turn_data["agent"],
            text=turn_data["text"],
        )
        turns.append(turn)

    return DialogScript(agents=agents, turns=turns)
