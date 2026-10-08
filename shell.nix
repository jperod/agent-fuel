{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  packages = with pkgs; [
    nodejs_22
    tmux
    git
  ];

  shellHook = ''
    echo "agent-fuel dev shell: node $(node -v), npm $(npm -v), tmux $(tmux -V)"
  '';
}
