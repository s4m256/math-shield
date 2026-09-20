// The demo invokes the same transformation as the extension, with no remote dictionary.
function repairExample() {
  const input = document.getElementById("input").value;
  const output = applyTranslations(input, {});
  document.getElementById("output").textContent = output;
  document.getElementById("status").textContent = output === input ? "No recognized unit changes." : "Recognized units repaired locally.";
}
document.getElementById("repair").addEventListener("click", repairExample);
repairExample();
