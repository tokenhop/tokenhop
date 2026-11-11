export async function fetchKiroProfileArn(accessToken) {
  if (!accessToken) return null;
  try {
    const response = await fetch(
      "https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ maxResults: 10 }),
      },
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.profiles?.find((p) => p.arn?.trim())?.arn?.trim() || null;
  } catch {
    return null;
  }
}
