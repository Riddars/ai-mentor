import ReactMarkdown, { type Components } from "react-markdown";

const COMPONENTS: Components = {
  h1: (props) => <h3 className="mt-4 mb-1.5 text-base font-semibold first:mt-0" {...props} />,
  h2: (props) => <h3 className="mt-4 mb-1.5 text-base font-semibold first:mt-0" {...props} />,
  h3: (props) => <h4 className="mt-4 mb-1.5 text-sm font-semibold first:mt-0" {...props} />,
  p: (props) => <p className="my-2 leading-relaxed" {...props} />,
  ul: (props) => <ul className="my-2 list-disc pl-5" {...props} />,
  ol: (props) => <ol className="my-2 list-decimal pl-5" {...props} />,
  li: (props) => <li className="my-0.5" {...props} />,
  a: (props) => <a className="text-primary hover:underline" target="_blank" rel="noreferrer" {...props} />,
  hr: () => <hr className="my-4 border-border" />,
  code: (props) => <code className="rounded bg-muted px-1.5 py-0.5 text-[0.8rem]" {...props} />,
  pre: (props) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-border bg-muted/50 px-3 py-2" {...props} />
  ),
};

/** Renders Markdown text (curator comments) with the panel's typography. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm">
      <ReactMarkdown components={COMPONENTS}>{children}</ReactMarkdown>
    </div>
  );
}
