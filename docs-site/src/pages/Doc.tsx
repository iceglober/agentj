import { useEffect } from "react";
import { Link } from "react-router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MdLink({ href, children }: { href?: string; children?: any }) {
  if (href && href.startsWith("/")) {
    return <Link to={href}>{children}</Link>;
  }
  return <a href={href}>{children}</a>;
}

export function Doc({ md, title }: { md: string; title: string }) {
  useEffect(() => {
    document.title = `${title} — glrs`;
  }, [title]);

  return (
    <main className="site-main doc">
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: MdLink }}>
        {md}
      </Markdown>
    </main>
  );
}
