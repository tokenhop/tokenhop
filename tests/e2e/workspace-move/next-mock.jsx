export default function Link({ href, children, prefetch: _prefetch, ...props }) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
