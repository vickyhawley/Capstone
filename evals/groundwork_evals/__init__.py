"""Groundwork eval harness.

This package is an external test rig. It calls the deployed Groundwork
API over HTTP and scores the responses against a labelled dataset. It
must never be imported by the application code — enforced socially, not
programmatically, but the import direction is one-way by design.
"""

__version__ = "0.1.0"
