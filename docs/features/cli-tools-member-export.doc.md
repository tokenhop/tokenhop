# CLI Tools for workspace members

When users and teams is on, members without host access can use **CLI Tools** to
set up a tool on their own computer. They copy or download the configuration; the
server host is never changed.

## Copy or download a configuration

1. Open **CLI Tools** and pick a tool.
2. Pick or type a model. Members may need to type the model name, because the
   provider model list isn't available to them.
3. Check the gateway URL. It defaults to the address you opened the dashboard
   at; change it if you reach the gateway at a different address.
4. Add an API key:
   - paste a key you already have, or
   - select **Create my key**, if your workspace role lets you create keys. It
     creates a personal key in your active workspace.
5. Select **Copy config**, or **Download** for a single file. Pick your operating
   system in the dialog, then save the files where the tool expects them.

The configuration contains your key, so treat it like a password. A key you
create is shown only once, inside this page's configuration. Copy or download it
before you leave or refresh the page. CLI Tools never saves the key, and it can't
be shown again. If you lose it, create a new key or ask a workspace owner or
admin.

## Applying settings on the host

Only an owner or admin can apply settings directly on the host, and only from
the host machine. Members see **Copy config** and no apply or reset actions.

## With users and teams off

CLI Tools works exactly as before, with the same labels. The member view and
**Create my key** don't appear.
