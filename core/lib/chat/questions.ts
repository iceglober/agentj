import type { QuestionAnswer, QuestionBatch, QuestionPort } from "../agent/questions";
import type { ChatEvent } from "./events";
import type { GuidedInputPort } from "./guided-input";

const questionLabel = (header: string, question: string): string => `${header}\n${question}`;

/** Adapts agent questions to the chat's serialized guided-input capability. */
export const createQuestionPort = (options: {
  guided: GuidedInputPort;
  onEvent?(event: ChatEvent): void | Promise<void>;
}): QuestionPort => ({
  async ask(questions: QuestionBatch): Promise<QuestionAnswer[] | null> {
    const answers: QuestionAnswer[] = [];
    for (const question of questions) {
      const choices = question.options.map(({ label, description }) => ({
        label,
        value: label,
        description,
      }));
      const selected: string[] = [];
      if (question.multiSelect) {
        while (true) {
          const available = choices.filter((choice) => !selected.includes(choice.value));
          if (available.length === 0) break;
          const answer = await options.guided.askInput({
            label: `${questionLabel(question.header, question.question)}\nSelect an answer, or choose Done.`,
            choices: [
              ...available,
              {
                label: "Done",
                value: "__agentj_question_done__",
                description: "Finish this question.",
              },
            ],
          });
          if (answer === null) return null;
          if (answer === "__agentj_question_done__") break;
          if (!selected.includes(answer)) selected.push(answer);
        }
      } else {
        const answer = await options.guided.askInput({
          label: questionLabel(question.header, question.question),
          choices,
        });
        if (answer === null) return null;
        selected.push(answer);
      }
      answers.push({ header: question.header, question: question.question, answers: selected });
    }
    await options.onEvent?.({ type: "questions-answered", answers });
    return answers;
  },
});
