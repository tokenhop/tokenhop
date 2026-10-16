// Browser stand-in for Node's `os`, needed only by open-sse/providers/shared.js header fingerprinting.
export const platform = () => "linux";
export const arch = () => "x64";
export default { platform, arch };
