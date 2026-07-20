import type { QuestionAnswer, QuestionBatch, QuestionPort } from "../agent/questions";
import type { ChatEvent } from "./events";
import type { GuidedInputPort } from "./guided-input";

const questionLabel = (header: string, question: string): string => `${header}\n${question}`;
const customAnswerValue = "__agentj_question_custom__";
const doneValue = "__agentj_question_done__";

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
      const askCustomAnswer = async (): Promise<string | null> => {
        const answer = await options.guided.askInput({
          label: `${questionLabel(question.header, question.question)}\nType your own answer.`,
          validate: (text) => (text.trim().length === 0 ? "Enter an answer." : null),
        });
        return answer?.trim() ?? null;
      };
      const customChoice = {
        label: "Type your own answer",
        value: customAnswerValue,
        description: "Enter a response not listed above.",
      };
      if (question.multiSelect) {
        while (true) {
          const available = choices.filter((choice) => !selected.includes(choice.value));
          const answer = await options.guided.askInput({
            label: `${questionLabel(question.header, question.question)}\nSelect an answer, type your own, or choose Done.`,
            choices: [
              ...available,
              customChoice,
              { label: "Done", value: doneValue, description: "Finish this question." },
            ],
          });
          if (answer === null) return null;
          if (answer === doneValue) break;
          if (answer === customAnswerValue) {
            const customAnswer = await askCustomAnswer();
            if (customAnswer === null) continue;
            if (!selected.includes(customAnswer)) selected.push(customAnswer);
            continue;
          }
          if (!selected.includes(answer)) selected.push(answer);
        }
      } else {
        while (true) {
          const answer = await options.guided.askInput({
            label: questionLabel(question.header, question.question),
            choices: [...choices, customChoice],
          });
          if (answer === null) return null;
          if (answer !== customAnswerValue) {
            selected.push(answer);
            break;
          }
          const customAnswer = await askCustomAnswer();
          if (customAnswer !== null) {
            selected.push(customAnswer);
            break;
          }
        }
      }
      answers.push({ header: question.header, question: question.question, answers: selected });
    }
    await options.onEvent?.({ type: "questions-answered", answers });
    return answers;
  },
});
