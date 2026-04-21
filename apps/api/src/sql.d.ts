// Text imports via esbuild's --loader:.sql=text.
declare module '*.sql' {
  const content: string;
  export default content;
}
