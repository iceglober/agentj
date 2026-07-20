declare module "turndown" {
  export default class TurndownService {
    constructor(options?: {
      headingStyle?: "setext" | "atx";
      codeBlockStyle?: "indented" | "fenced";
    });
    turndown(html: string): string;
  }
}
