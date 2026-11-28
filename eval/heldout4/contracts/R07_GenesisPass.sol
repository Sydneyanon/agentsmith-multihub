// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

abstract contract MiniERC721 {
    mapping(uint256 => address) internal _ownerOf;
    mapping(address => uint256) internal _balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);

    function ownerOf(uint256 id) public view returns (address o) {
        o = _ownerOf[id];
        require(o != address(0), "not minted");
    }

    function balanceOf(address o) public view returns (uint256) {
        return _balanceOf[o];
    }

    function _mint(address to, uint256 id) internal {
        require(to != address(0), "zero");
        require(_ownerOf[id] == address(0), "minted");
        _balanceOf[to]++;
        _ownerOf[id] = to;
        emit Transfer(address(0), to, id);
    }

    function _safeMint(address to, uint256 id) internal {
        _mint(to, id);
        if (to.code.length > 0) {
            require(
                IERC721Receiver(to).onERC721Received(msg.sender, address(0), id, "") ==
                    IERC721Receiver.onERC721Received.selector,
                "non-receiver"
            );
        }
    }
}

contract GenesisPass is MiniERC721 {
    uint256 public constant MAX_SUPPLY = 5000;
    uint256 public constant MAX_PER_WALLET = 3;
    uint256 public constant PRICE = 0.05 ether;

    address public immutable treasury;
    uint256 public nextId = 1;
    mapping(address => uint256) public mintedBy;

    constructor(address treasury_) {
        treasury = treasury_;
    }

    function mint(uint256 quantity) external payable {
        require(quantity > 0, "zero");
        require(msg.value == PRICE * quantity, "wrong price");
        require(mintedBy[msg.sender] + quantity <= MAX_PER_WALLET, "wallet limit");
        require(nextId + quantity - 1 <= MAX_SUPPLY, "sold out");
        for (uint256 i = 0; i < quantity; i++) {
            uint256 id = nextId++;
            _safeMint(msg.sender, id);
        }
        mintedBy[msg.sender] += quantity;
    }

    function sweep() external {
        (bool ok, ) = treasury.call{value: address(this).balance}("");
        require(ok, "sweep failed");
    }
}
