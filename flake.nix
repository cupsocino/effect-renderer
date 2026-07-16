{
  description = "Three.js Shaiya EFT/3DE effect renderer";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system:
          f (import nixpkgs { inherit system; }));
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
          ];

          shellHook = ''
            echo "eftrender: npm install && npm run dev"
          '';
        };
      });
    };
}
